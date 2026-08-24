import type { Database } from "bun:sqlite";

import { executeAdapter } from "../adapters/executor.ts";
import type { Autonomy, ExecRequest, ExecResult } from "../adapters/types.ts";
import {
  DEFAULT_INSTANCE,
  POLICY_VERSION,
  ceilingFor,
  clampAutonomy,
  selectTarget,
  type Target,
} from "../registry/registry.ts";
import { newId, nowIso, withBusyRetry } from "../store/store.ts";
import {
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_HOPS,
  HOPS_ENV,
  SETTING_MAX_CONCURRENT,
  SETTING_MAX_HOPS,
  type AttemptView,
  type RunRequest,
  type RunStatus,
  type RunView,
} from "./types.ts";

/**
 * The run supervisor: runs/attempts state machine over SQLite (the source of
 * truth) with the adapter executor as the only execution path. Phase 1 runs one
 * attempt per run; failover in phase 2 adds attempts under the same run.
 */

const POLL_MS = 250;
/** Between SIGTERM and SIGKILL of a cancelled attempt's process group. */
const KILL_ESCALATION_MS = 3_000;
const MAX_OUTPUT_CHARS = 200_000;
const MAX_RAW_TAIL_CHARS = 32_000;
/**
 * How long a `queued` attempt may sit before recovery treats it as abandoned.
 * Long enough that another process launching a run right now is never swept.
 */
const QUEUED_GRACE_MS = 60_000;

const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "succeeded",
  "failed",
  "timeout",
  "cancelled",
  "orphaned",
]);

export interface ExecHooks {
  /** Called with the callee's pid (= its process-group id) once spawned. */
  onSpawn?: (pid: number) => void;
}

export type AdapterExec = (req: ExecRequest, hooks?: ExecHooks) => Promise<ExecResult>;

export interface TargetResolver {
  resolve(model: string, opts: { instance?: string }): Target;
}

export interface SupervisorInit {
  db: Database;
  /** Baton's inherited environment; the callee env is built from it verbatim. */
  env: Record<string, string | undefined>;
  hostCwd: string;
  resolver?: TargetResolver;
  exec?: AdapterExec;
  pollMs?: number;
}

interface Live {
  runId: string;
  pid: number | null;
  cancelled: boolean;
}

export class Supervisor {
  private readonly db: Database;
  private readonly env: Record<string, string | undefined>;
  private readonly hostCwd: string;
  private readonly resolver: TargetResolver;
  private readonly exec: AdapterExec;
  private readonly pollMs: number;
  /** Attempts this process launched and still owns, keyed by attempt id. */
  private readonly live = new Map<string, Live>();

  constructor(init: SupervisorInit) {
    this.db = init.db;
    this.env = init.env;
    this.hostCwd = init.hostCwd;
    this.resolver = init.resolver ?? {
      resolve: (model, opts) => selectTarget(init.db, model, opts),
    };
    this.exec = init.exec ?? defaultExec;
    this.pollMs = init.pollMs ?? POLL_MS;
    this.recoverOrphans();
  }

  /**
   * Launches a run and returns as soon as it is `running`; `settled` resolves
   * once the attempt's outcome is recorded. Callers implement wait themselves
   * (waitForRun) so the MCP surface stays handle-based.
   */
  async startRun(req: RunRequest): Promise<{ view: RunView; settled: Promise<void> }> {
    const depth = this.hopDepth();
    const maxHops = this.maxHops();
    if (depth >= maxHops) {
      throw new Error(
        `Refusing to delegate: this process is already ${depth} delegation hop(s) deep (${HOPS_ENV}=${depth}) and the '${SETTING_MAX_HOPS}' setting is ${maxHops}. Raise it with 'baton set ${SETTING_MAX_HOPS} <n>' if this chain is intended.`,
      );
    }

    const key = req.idempotencyKey;
    if (key !== undefined && key.length === 0) {
      throw new Error("idempotency_key must be non-empty when provided.");
    }
    const cwd = req.cwd ?? this.hostCwd;
    // The key alone is not the identity of the request: dedup must only fire
    // for the payload the key was minted for (PLAN.md §Execution: payload-bound).
    const payloadHash = digestPayload(req, cwd);
    if (key !== undefined) {
      const existing = this.findByKey(key, payloadHash);
      if (existing) return deduped(existing);
    }

    const target = this.resolver.resolve(req.model, { instance: req.instance });
    const autonomy = clampAutonomy(
      req.options?.autonomy,
      ceilingFor(this.db, target.spec.app),
      target.spec.defaultAutonomy,
    );
    // Autonomy is part of the execution-target identity: the same model at a
    // different authority level is not interchangeable evidence.
    const fingerprint = `${target.targetFingerprint}+${autonomy}`;
    const timeoutMs = req.options?.timeoutMs ?? target.spec.defaultTimeoutMs;
    const runId = newId("run");
    const attemptId = newId("att");

    try {
      withBusyRetry(() =>
        this.insert({
          req,
          runId,
          attemptId,
          target,
          fingerprint,
          autonomy,
          timeoutMs,
          cwd,
          payloadHash,
        }),
      );
    } catch (err) {
      if (key !== undefined && isUniqueViolation(err)) {
        const existing = this.findByKey(key, payloadHash);
        if (existing) return deduped(existing);
      }
      throw err;
    }

    this.live.set(attemptId, { runId, pid: null, cancelled: false });
    this.markRunning(runId, attemptId);
    const settled = this.execute({
      runId,
      attemptId,
      target,
      autonomy,
      timeoutMs,
      cwd,
      depth,
      prompt: req.prompt,
    });

    return { view: this.getRun(runId)!, settled };
  }

  getRun(runId: string): RunView | undefined {
    const run = this.db
      .query<RunRow, [string]>(
        "SELECT id, status, model, app, slug, instance, created_at, updated_at FROM runs WHERE id = ?",
      )
      .get(runId);
    if (!run) return undefined;
    const attempts = this.db
      .query<AttemptRow, [string]>(
        "SELECT id, seq, target, status, exit_code, output, error, started_at, finished_at FROM attempts WHERE run_id = ? ORDER BY seq",
      )
      .all(runId);
    return toView(run, attempts);
  }

  /** Polls until the run reaches a terminal status or the budget runs out. */
  async waitForRun(runId: string, budgetMs: number): Promise<RunView> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const view = this.getRun(runId);
      if (!view) throw new Error(`Unknown run '${runId}'.`);
      const remaining = deadline - Date.now();
      if (TERMINAL.has(view.status) || remaining <= 0) return view;
      await sleep(Math.min(this.pollMs, remaining));
    }
  }

  /** Kills the live attempt's process group and marks the run cancelled. */
  cancelRun(runId: string): void {
    for (const live of this.live.values()) {
      if (live.runId !== runId || live.cancelled) continue;
      live.cancelled = true;
      const pid = live.pid;
      if (pid === null || pid <= 0) continue;
      killGroup(pid, "SIGTERM");
      const escalation = setTimeout(() => killGroup(pid, "SIGKILL"), KILL_ESCALATION_MS);
      escalation.unref?.();
    }

    const now = nowIso();
    withBusyRetry(() =>
      this.db.transaction(() => {
        this.db
          .query(
            "UPDATE attempts SET status = 'cancelled', finished_at = COALESCE(finished_at, ?) WHERE run_id = ? AND status IN ('queued','running')",
          )
          .run(now, runId);
        this.db
          .query(
            "UPDATE runs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('queued','running')",
          )
          .run(now, runId);
      })(),
    );
  }

  /**
   * Release everything this process launched. A host that disconnects or kills
   * the server must not leave callee CLIs running unsupervised with nobody left
   * to record their outcome — each live run is cancelled and its group killed.
   */
  shutdown(): void {
    for (const runId of new Set([...this.live.values()].map((l) => l.runId))) {
      this.cancelRun(runId);
    }
  }

  /**
   * Attempts left mid-flight by a crashed supervisor. Nobody else can ever
   * settle them: their output pipes died with the process that launched them,
   * so leaving one 'queued'/'running' strands the run forever (and lets an
   * idempotent retry dedup onto a corpse). Recovery records that fact — it
   * never kills a process it does not own.
   */
  recoverOrphans(): void {
    const rows = this.db
      .query<OrphanRow, []>(
        `SELECT a.id, a.run_id, a.pid, a.status, r.created_at
         FROM attempts a JOIN runs r ON r.id = a.run_id
         WHERE a.status IN ('queued','running')`,
      )
      .all();
    for (const row of rows) {
      if (this.live.has(row.id)) continue;
      const reason = orphanReason(row);
      if (reason === null) continue;
      const now = nowIso();
      withBusyRetry(() =>
        this.db.transaction(() => {
          this.db
            .query(
              "UPDATE attempts SET status = 'orphaned', finished_at = COALESCE(finished_at, ?), error = COALESCE(error, ?) WHERE id = ?",
            )
            .run(now, reason, row.id);
          this.db
            .query(
              "UPDATE runs SET status = 'orphaned', updated_at = ? WHERE id = ? AND status IN ('queued','running')",
            )
            .run(now, row.run_id);
        })(),
      );
    }
  }

  private async execute(ctx: {
    runId: string;
    attemptId: string;
    target: Target;
    autonomy: Autonomy;
    timeoutMs: number;
    cwd: string;
    depth: number;
    prompt: string;
  }): Promise<void> {
    let res: ExecResult;
    try {
      res = await this.exec(
        {
          spec: ctx.target.spec,
          // The registry already verified this path; spawning the bare name
          // would let an instance's PATH overlay swap the executable.
          binaryPath: ctx.target.binaryPath,
          slug: ctx.target.slug,
          prompt: ctx.prompt,
          cwd: ctx.cwd,
          env: this.calleeEnv(ctx.target, ctx.depth),
          autonomy: ctx.autonomy,
          timeoutMs: ctx.timeoutMs,
        },
        { onSpawn: (pid) => this.notePid(ctx.attemptId, pid) },
      );
    } catch (err) {
      res = {
        ok: false,
        exitCode: null,
        timedOut: false,
        rawTail: "",
        error: `executor failed: ${message(err)}`,
        durationMs: 0,
      };
    }

    const cancelled = this.live.get(ctx.attemptId)?.cancelled ?? false;
    this.live.delete(ctx.attemptId);
    const status: RunStatus = cancelled
      ? "cancelled"
      : res.timedOut
        ? "timeout"
        : res.ok
          ? "succeeded"
          : "failed";

    try {
      const now = nowIso();
      withBusyRetry(() =>
        this.db.transaction(() => {
          this.db
            .query(
              "UPDATE attempts SET status = ?, exit_code = ?, output = ?, raw_tail = ?, error = ?, session_ref = ?, finished_at = ? WHERE id = ?",
            )
            .run(
              status,
              res.exitCode ?? null,
              res.output === undefined ? null : head(res.output, MAX_OUTPUT_CHARS),
              res.rawTail ? tail(res.rawTail, MAX_RAW_TAIL_CHARS) : null,
              res.error ?? null,
              res.sessionRef ?? null,
              now,
              ctx.attemptId,
            );
          this.db
            .query("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?")
            .run(status, now, ctx.runId);
        })(),
      );
    } catch {
      // A run whose outcome cannot be written is worse than useless to retry
      // here; recoverOrphans() reconciles it on the next start.
    }
  }

  /**
   * Inherited environment + the instance's overlay + the incremented hop count.
   * Nothing is scrubbed: Baton is not more special than a shell (PLAN.md §Identity).
   */
  private calleeEnv(target: Target, depth: number): Record<string, string | undefined> {
    return {
      ...this.env,
      ...this.overlay(target.spec.app, target.instance),
      [HOPS_ENV]: String(depth + 1),
    };
  }

  private overlay(app: string, instance: string): Record<string, string> {
    if (instance === DEFAULT_INSTANCE) return {};
    const row = this.db
      .query<{ env: string }, [string, string]>(
        "SELECT env FROM instances WHERE app = ? AND name = ?",
      )
      .get(app, instance);
    if (!row) return {};
    try {
      const parsed: unknown = JSON.parse(row.env);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
    } catch {
      return {};
    }
  }

  private notePid(attemptId: string, pid: number): void {
    const live = this.live.get(attemptId);
    if (live) live.pid = pid;
    try {
      withBusyRetry(() =>
        this.db.query("UPDATE attempts SET pid = ? WHERE id = ?").run(pid, attemptId),
      );
    } catch {
      // The pid is a recovery hint, not run state; losing it must not fail the run.
    }
    if (live?.cancelled) killGroup(pid, "SIGTERM"); // cancelled before we knew the pid
  }

  private insert(a: {
    req: RunRequest;
    runId: string;
    attemptId: string;
    target: Target;
    fingerprint: string;
    autonomy: Autonomy;
    timeoutMs: number;
    cwd: string;
    payloadHash: string;
  }): void {
    const now = nowIso();
    // BEGIN IMMEDIATE: the admission count and the insert that consumes a slot
    // must not interleave with another process doing the same.
    this.db
      .transaction(() => {
        const cap = this.maxConcurrent();
        const running =
          this.db
            .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM attempts WHERE status = 'running'")
            .get()?.n ?? 0;
        if (running >= cap) {
          throw new Error(
            `Refusing to delegate: ${running} attempt(s) are already running and this scope's concurrency cap ('${SETTING_MAX_CONCURRENT}') is ${cap}. Retry once one finishes, or raise it with 'baton set ${SETTING_MAX_CONCURRENT} <n>'.`,
          );
        }
        this.db
          .query(
            `INSERT INTO runs (id, idempotency_key, payload_hash, model, app, slug, instance, prompt, cwd, category, options, status, policy_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
          )
          .run(
            a.runId,
            a.req.idempotencyKey ?? null,
            a.payloadHash,
            a.req.model,
            a.target.spec.app,
            a.target.slug,
            a.target.instance,
            a.req.prompt,
            a.cwd,
            a.req.category ?? null,
            JSON.stringify({ autonomy: a.autonomy, timeoutMs: a.timeoutMs }),
            POLICY_VERSION,
            now,
            now,
          );
        this.db
          .query(
            "INSERT INTO attempts (id, run_id, seq, target, status) VALUES (?, ?, 1, ?, 'queued')",
          )
          .run(a.attemptId, a.runId, a.fingerprint);
      })
      .immediate();
  }

  private markRunning(runId: string, attemptId: string): void {
    const now = nowIso();
    withBusyRetry(() =>
      this.db.transaction(() => {
        this.db
          .query("UPDATE attempts SET status = 'running', started_at = ? WHERE id = ?")
          .run(now, attemptId);
        this.db
          .query("UPDATE runs SET status = 'running', updated_at = ? WHERE id = ?")
          .run(now, runId);
      })(),
    );
  }

  /**
   * The existing run for `key`, or undefined. A key reused for a *different*
   * payload is a caller bug, not a retry: dedup would silently answer the wrong
   * question, so it is refused. Rows written before payload binding existed
   * (payload_hash NULL) cannot be checked and still dedup.
   */
  private findByKey(key: string, payloadHash: string): RunView | undefined {
    const row = this.db
      .query<{ id: string; payload_hash: string | null }, [string]>(
        "SELECT id, payload_hash FROM runs WHERE idempotency_key = ?",
      )
      .get(key);
    if (!row) return undefined;
    if (row.payload_hash !== null && row.payload_hash !== payloadHash) {
      throw new Error(
        `idempotency_key '${key}' already belongs to run ${row.id}, which was launched with a different payload. Retries must repeat the original request exactly; use a new key to run something else.`,
      );
    }
    return this.getRun(row.id);
  }

  private hopDepth(): number {
    const depth = Number.parseInt(this.env[HOPS_ENV] ?? "0", 10);
    return Number.isFinite(depth) && depth > 0 ? depth : 0;
  }

  private maxHops(): number {
    return this.intSetting(SETTING_MAX_HOPS, DEFAULT_MAX_HOPS, 0);
  }

  private maxConcurrent(): number {
    return this.intSetting(SETTING_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT, 1);
  }

  private intSetting(key: string, fallback: number, min: number): number {
    const row = this.db
      .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?")
      .get(key);
    const parsed = Number.parseInt(row?.value ?? "", 10);
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
  }
}

/**
 * Canonical digest of everything that decides what the callee actually does.
 * Two requests with the same digest are the same request; anything else reusing
 * a key is a mistake worth naming.
 */
function digestPayload(req: RunRequest, cwd: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(
    JSON.stringify([
      req.model,
      req.prompt,
      cwd,
      req.instance ?? DEFAULT_INSTANCE,
      req.category ?? "",
      canonical(req.options ?? {}),
    ]),
  );
  return hasher.digest("hex");
}

/** Key order must not change the digest. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canonical(v)]),
  );
}

export function createSupervisor(init: SupervisorInit): Supervisor {
  return new Supervisor(init);
}

const defaultExec: AdapterExec = (req, hooks) =>
  executeAdapter({ ...req, ...(hooks?.onSpawn ? { onSpawn: hooks.onSpawn } : {}) });

interface RunRow {
  id: string;
  status: RunStatus;
  model: string;
  app: string;
  slug: string;
  instance: string;
  created_at: string;
  updated_at: string;
}

interface AttemptRow {
  id: string;
  seq: number;
  target: string;
  status: RunStatus;
  exit_code: number | null;
  output: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

function toView(run: RunRow, attempts: AttemptRow[]): RunView {
  const last = attempts[attempts.length - 1];
  const answered = [...attempts].reverse().find((a) => a.status === "succeeded" && a.output);
  return {
    runId: run.id,
    status: run.status,
    model: run.model,
    app: run.app,
    slug: run.slug,
    instance: run.instance,
    ...(answered?.output ? { output: answered.output } : {}),
    ...(run.status !== "succeeded" && last?.error ? { error: last.error } : {}),
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    attempts: attempts.map(toAttemptView),
  };
}

function toAttemptView(a: AttemptRow): AttemptView {
  return {
    id: a.id,
    seq: a.seq,
    target: a.target,
    status: a.status,
    exitCode: a.exit_code,
    ...(a.error ? { error: a.error } : {}),
    ...(a.started_at ? { startedAt: a.started_at } : {}),
    ...(a.finished_at ? { finishedAt: a.finished_at } : {}),
  };
}

function deduped(view: RunView): { view: RunView; settled: Promise<void> } {
  return { view: { ...view, deduplicated: true }, settled: Promise.resolve() };
}

interface OrphanRow {
  id: string;
  run_id: string;
  pid: number | null;
  status: RunStatus;
  created_at: string;
}

/** Why this unowned attempt is orphaned, or null to leave it alone. */
function orphanReason(row: OrphanRow): string | null {
  if (row.status === "queued") {
    // Another process may be between insert and launch right now; only a run
    // that has sat queued past the grace period is certainly abandoned.
    const age = Date.now() - Date.parse(row.created_at);
    if (Number.isFinite(age) && age < QUEUED_GRACE_MS) return null;
    return "orphaned: still queued long after it was recorded — the supervisor died before launching the callee";
  }
  const pid = row.pid;
  if (pid === null || pid <= 0) {
    return "orphaned: no pid recorded, the supervisor died before the callee was tracked";
  }
  if (isGone(pid) && isGone(-pid)) {
    return `orphaned: process group ${pid} was already gone at supervisor startup`;
  }
  return `orphaned: process group ${pid} may still be running, but the supervisor that launched it is gone, so its outcome can never be recorded. It was NOT killed — Baton does not kill what it does not own; stop it yourself if it should not be running.`;
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal); // negative pid => the whole process group
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/** ESRCH means gone; EPERM means alive but not ours, which must be left alone. */
function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as { code?: unknown } | null)?.code === "ESRCH";
  }
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}

function head(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… [truncated ${value.length - max} chars]`;
}

function tail(value: string, max: number): string {
  return value.length <= max ? value : value.slice(-max);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
