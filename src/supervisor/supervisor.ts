import type { Database } from "bun:sqlite";

import { classifyFailure, executeAdapter } from "../adapters/executor.ts";
import {
  AUTONOMY_ORDER,
  type AdapterSpec,
  type Autonomy,
  type ExecRequest,
  type ExecResult,
} from "../adapters/types.ts";
import { recordReliability } from "../eval/evalStore.ts";
import {
  clearCooldown,
  dropRunEvent,
  recordAdmissionFailure,
  recordRun,
} from "../quota/quota.ts";
import {
  DEFAULT_INSTANCE,
  POLICY_VERSION,
  candidateKey,
  ceilingFor,
  clampAutonomy,
  selectTarget,
  targetFor,
  type SelectOptions,
  type Target,
} from "../registry/registry.ts";
import { newId, nowIso, withBusyRetry } from "../store/store.ts";
import {
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_HOPS,
  HOPS_ENV,
  RESUMED_FROM,
  SETTING_MAX_CONCURRENT,
  SETTING_MAX_HOPS,
  type AttemptView,
  type ResumeRequest,
  type RunOptions,
  type RunRequest,
  type RunStatus,
  type RunView,
} from "./types.ts";

/**
 * The run supervisor: runs/attempts state machine over SQLite (the source of
 * truth) with the adapter executor as the only execution path. A run is the
 * caller's request; each execution is an attempt, and an admission failure —
 * a rate-limit or auth refusal *before* the callee started work — adds another
 * attempt on the next pool candidate under the same run (PLAN.md §Instance
 * pools). Any other failure ends the run: replaying work that may already have
 * had side effects is the caller's decision, not Baton's.
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
/**
 * Session handles come out of a callee's stdout, i.e. untrusted content. They
 * are passed as a single argv element (never a shell string), so the only real
 * hazard left is a handle that reads as a flag — which this shape forbids.
 */
const SESSION_REF = /^[A-Za-z0-9][\w./-]*$/;

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
  resolve(model: string, opts: SelectOptions): Target;
  /**
   * The exact target a resumed run must land on — a lookup, never a selection:
   * the session lives in one instance's config dir, so affinity outranks pool
   * balancing entirely (PLAN.md §Session affinity). Optional so existing
   * resolvers keep working; the registry's `targetFor` lookup is the default.
   */
  pinned?(ref: PinnedRef): Target;
}

/** Everything the original run recorded about where it ran. */
export interface PinnedRef {
  model: string;
  app: string;
  slug: string;
  instance: string;
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
  /** quota_events row claimed at admission; dropped again if it was refused. */
  quotaEventId: number | null;
}

/** Everything one attempt needs, plus what its successor would need. */
interface AttemptCtx {
  runId: string;
  attemptId: string;
  seq: number;
  model: string;
  prompt: string;
  cwd: string;
  depth: number;
  options?: RunOptions;
  /** The caller's category, if any: selection ranks per category. */
  category?: string;
  /** Set only when the caller pinned an instance — pins never fail over. */
  requestedInstance?: string;
  target: Target;
  /** attempts.target: the execution-target fingerprint incl. resolved autonomy. */
  fingerprint: string;
  autonomy: Autonomy;
  timeoutMs: number;
  /** `<app>:<instance>` keys this run has used; the cap on a failover chain. */
  tried: string[];
  /** Set on a resumed run: the handle the adapter's resume argv continues. */
  resumeRef?: string;
  /**
   * Instance overlay resolved once, up front. A resume looks it up strictly
   * (the instance must still be defined), so it must not be re-read loosely
   * on the way to the executor.
   */
  overlay?: Record<string, string>;
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
    const depth = this.guardHops();

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

    const target = this.resolver.resolve(req.model, {
      instance: req.instance,
      exclude: [],
      // Ratings are per (target, category), so ranking is judged on the kind of
      // work this run actually is.
      ...(req.category ? { category: req.category } : {}),
      // ...and per autonomy, so candidates are rated at the authority level
      // this run will actually execute at, not the adapter's default.
      ...(req.options?.autonomy ? { autonomy: req.options.autonomy } : {}),
    });
    const { autonomy, timeoutMs, fingerprint } = this.resolve(target, req.options);
    const runId = newId("run");
    const attemptId = newId("att");

    try {
      withBusyRetry(() =>
        this.insert({
          runId,
          attemptId,
          fingerprint,
          model: req.model,
          app: target.spec.app,
          slug: target.slug,
          instance: target.instance,
          prompt: req.prompt,
          cwd,
          ...(req.category ? { category: req.category } : {}),
          ...(key !== undefined ? { idempotencyKey: key } : {}),
          payloadHash,
          options: { autonomy, timeoutMs },
        }),
      );
    } catch (err) {
      if (key !== undefined && isUniqueViolation(err)) {
        const existing = this.findByKey(key, payloadHash);
        if (existing) return deduped(existing);
      }
      throw err;
    }

    this.markRunning(runId, attemptId);
    const settled = this.execute({
      runId,
      attemptId,
      seq: 1,
      model: req.model,
      prompt: req.prompt,
      cwd,
      depth,
      ...(req.options ? { options: req.options } : {}),
      ...(req.category ? { category: req.category } : {}),
      ...(req.instance ? { requestedInstance: req.instance } : {}),
      target,
      fingerprint,
      autonomy,
      timeoutMs,
      tried: [candidateKey(target.spec.app, target.instance)],
    });

    return { view: this.getRun(runId)!, settled };
  }

  /**
   * Continues a run's session on the SAME app and instance it ran on: session
   * state lives in that instance's config dir, so affinity bypasses pool
   * balancing entirely (PLAN.md §Session affinity). The original run is left
   * untouched; this is a new run that records which one it continues, so the
   * caller's decision to resume is visible in the evidence.
   */
  async resumeRun(req: ResumeRequest): Promise<{ view: RunView; settled: Promise<void> }> {
    const depth = this.guardHops();
    const origin = this.db
      .query<OriginRow, [string]>(
        "SELECT status, model, app, slug, instance, cwd, category, options FROM runs WHERE id = ?",
      )
      .get(req.runId);
    if (!origin) throw new Error(`Unknown run '${req.runId}'.`);
    if (!TERMINAL.has(origin.status)) {
      // The callee still owns that session on disk; a second turn against it
      // would race the process writing it.
      throw new Error(
        `Cannot resume run '${req.runId}': it is still ${origin.status}. Wait for it to finish (or cancel it) before continuing its session.`,
      );
    }

    const sessionRef = this.sessionRefOf(req.runId);
    const target = this.pin({
      model: origin.model,
      app: origin.app,
      slug: origin.slug,
      instance: origin.instance,
    });
    if (!target.spec.resume) {
      throw new Error(
        `Cannot resume run '${req.runId}': the '${origin.app}' adapter declares no non-interactive resume, so its session can only be continued by hand. Start a new run with the context it needs.`,
      );
    }
    // Fail closed: without the definition the overlay is gone, and running
    // without it would hand the session to whatever identity the bare
    // environment supplies — a different account than the one holding it.
    const overlay = this.overlay(origin.app, origin.instance, { strict: true });
    const options = { ...inheritedOptions(origin.options), ...req.options };
    const { autonomy, timeoutMs, fingerprint } = this.resolve(target, options);
    const runId = newId("run");
    const attemptId = newId("att");

    withBusyRetry(() =>
      this.insert({
        runId,
        attemptId,
        fingerprint,
        model: origin.model,
        app: origin.app,
        slug: origin.slug,
        instance: origin.instance,
        prompt: req.prompt,
        cwd: origin.cwd,
        ...(origin.category ? { category: origin.category } : {}),
        // A resume is a fresh request by definition; nothing may dedup onto it.
        payloadHash: null,
        options: { autonomy, timeoutMs, [RESUMED_FROM]: req.runId },
      }),
    );

    this.markRunning(runId, attemptId);
    const settled = this.execute({
      runId,
      attemptId,
      seq: 1,
      model: origin.model,
      prompt: req.prompt,
      cwd: origin.cwd,
      depth,
      options,
      ...(origin.category ? { category: origin.category } : {}),
      // The pinned instance is also the only one: a resumed run never fails over.
      requestedInstance: origin.instance,
      target,
      fingerprint,
      autonomy,
      timeoutMs,
      tried: [candidateKey(origin.app, origin.instance)],
      resumeRef: sessionRef,
      overlay,
    });

    return { view: this.getRun(runId)!, settled };
  }

  getRun(runId: string): RunView | undefined {
    const run = this.db
      .query<RunRow, [string]>(
        "SELECT id, status, model, app, slug, instance, options, created_at, updated_at FROM runs WHERE id = ?",
      )
      .get(runId);
    if (!run) return undefined;
    const attempts = this.db
      .query<AttemptRow, [string]>(
        "SELECT id, seq, target, status, exit_code, output, error, session_ref, started_at, finished_at FROM attempts WHERE run_id = ? ORDER BY seq",
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
        `SELECT a.id, a.run_id, a.pid, a.owner_pid, a.status, r.created_at
         FROM attempts a JOIN runs r ON r.id = a.run_id
         WHERE a.status IN ('queued','running')`,
      )
      .all();
    for (const row of rows) {
      if (this.live.has(row.id)) continue;
      // Several Baton processes share a scope (a CLI run + a callee's own MCP
      // server, both against the same DB). An attempt whose owning process is
      // alive is not abandoned — it is simply someone else's.
      if (row.owner_pid !== null && row.owner_pid > 0 && !isGone(row.owner_pid)) continue;
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

  /** Runs attempts until one settles the run — the failover chain lives here. */
  private async execute(first: AttemptCtx): Promise<void> {
    for (let ctx: AttemptCtx | undefined = first; ctx; ) {
      const res = await this.invoke(ctx);
      ctx = this.settle(ctx, res);
    }
  }

  private async invoke(ctx: AttemptCtx): Promise<ExecResult> {
    this.live.set(ctx.attemptId, {
      runId: ctx.runId,
      pid: null,
      cancelled: false,
      quotaEventId: null,
    });
    try {
      return await this.exec(
        {
          spec:
            ctx.resumeRef === undefined
              ? ctx.target.spec
              : resumeSpec(ctx.target.spec, ctx.resumeRef),
          // The registry already verified this path; spawning the bare name
          // would let an instance's PATH overlay swap the executable.
          binaryPath: ctx.target.binaryPath,
          slug: ctx.target.slug,
          prompt: ctx.prompt,
          cwd: ctx.cwd,
          env: this.calleeEnv(ctx),
          autonomy: ctx.autonomy,
          timeoutMs: ctx.timeoutMs,
        },
        {
          onSpawn: (pid) => {
            this.notePid(ctx.attemptId, pid);
            this.noteAdmitted(ctx);
          },
        },
      );
    } catch (err) {
      return {
        ok: false,
        // The callee never ran: a Baton-side failure is not the target's.
        started: false,
        exitCode: null,
        timedOut: false,
        rawTail: "",
        error: `executor failed: ${message(err)}`,
        durationMs: 0,
      };
    }
  }

  /**
   * The callee is running, so its window slot is spent NOW — not when it
   * finishes. A long run recorded at completion lands in the wrong 5-hour
   * window, and every selection made while it runs sees headroom it no longer
   * has and piles onto the same instance (PLAN.md §Proactive spreading).
   * `settle` gives the slot back if the spawn turned out to be a refusal.
   */
  private noteAdmitted(ctx: AttemptCtx): void {
    try {
      const id = withBusyRetry(() =>
        recordRun(this.db, ctx.target.spec.app, ctx.target.instance, nowIso()),
      );
      const live = this.live.get(ctx.attemptId);
      if (live) live.quotaEventId = id;
    } catch {
      // Evidence is not run state: losing it must never fail the run.
    }
  }

  /**
   * Records an attempt's outcome and its evidence, and returns the next attempt
   * when this one was refused admission and another candidate is left.
   */
  private settle(ctx: AttemptCtx, res: ExecResult): AttemptCtx | undefined {
    const live = this.live.get(ctx.attemptId);
    const cancelled = live?.cancelled ?? false;
    const quotaEventId = live?.quotaEventId ?? null;
    this.live.delete(ctx.attemptId);
    const status: RunStatus = cancelled
      ? "cancelled"
      : res.timedOut
        ? "timeout"
        : res.ok
          ? "succeeded"
          : "failed";
    // A timeout is deliberately not an admission failure however its output
    // reads: the callee had the whole budget to act, so re-running it could
    // duplicate side effects (PLAN.md §Failover on admission failure only).
    // classifyFailure applies the same rule to the output itself: a rejection
    // printed *after* work-started evidence is a failure, never a replay.
    const refused =
      !cancelled &&
      !res.ok &&
      !res.timedOut &&
      classifyFailure(ctx.target.spec, res) === "admission";
    this.observe(ctx, res, { status, cancelled, refused, quotaEventId });

    const next = refused ? this.nextCandidate(ctx) : undefined;
    const error = failureText(res, {
      refused,
      failedOver: next !== undefined,
      resumed: ctx.resumeRef !== undefined,
    });
    try {
      return this.commit(ctx, res, { status, error, next });
    } catch {
      // A run whose outcome cannot be written is worse than useless to retry
      // here; recoverOrphans() reconciles it on the next start.
      return undefined;
    }
  }

  /**
   * Quota and reliability evidence for one completed attempt. The window slot
   * was already claimed at admission (`noteAdmitted`); an admission failure
   * spent nothing after all, so its claim is given back and the instance cools
   * down instead. Only a success proves admission works again, so only a
   * success ends the strike chain. Extraction and spawn failures are
   * reliability against the target, never quality against the model
   * (PLAN.md §Layering and sharing) — and an attempt whose callee never ran is
   * neither: it is a Baton-side fact.
   */
  private observe(
    ctx: AttemptCtx,
    res: ExecResult,
    o: { status: RunStatus; cancelled: boolean; refused: boolean; quotaEventId: number | null },
  ): void {
    const app = ctx.target.spec.app;
    const now = nowIso();
    try {
      if (o.refused) {
        if (o.quotaEventId !== null) dropRunEvent(this.db, o.quotaEventId);
        // No adapter's live probe produced a parseable reset time, so the
        // backoff decides; pass one here the moment an adapter can extract it.
        recordAdmissionFailure(this.db, app, ctx.target.instance, now, res.error);
      } else if (o.status === "succeeded") {
        clearCooldown(this.db, app, ctx.target.instance);
      }
      // A cancelled attempt says nothing about the target: the user stopped it.
      if (!o.cancelled && res.started) {
        recordReliability(this.db, ctx.fingerprint, o.status === "succeeded");
      }
    } catch {
      // Evidence is not run state: losing it must never fail the run.
    }
  }

  /** The next pool candidate for a refused attempt, or undefined when spent. */
  private nextCandidate(ctx: AttemptCtx): AttemptCtx | undefined {
    // A resumed run has exactly one home: the session it continues lives in
    // that instance's config dir, so there is nowhere to fail over to.
    if (ctx.resumeRef !== undefined) return undefined;
    let target: Target;
    try {
      target = this.resolver.resolve(ctx.model, {
        // An explicitly requested instance is a pin, not a preference: it is
        // already in `tried`, so selection finds nothing and the run fails.
        ...(ctx.requestedInstance ? { instance: ctx.requestedInstance } : {}),
        ...(ctx.category ? { category: ctx.category } : {}),
        ...(ctx.options?.autonomy ? { autonomy: ctx.options.autonomy } : {}),
        exclude: ctx.tried,
      });
    } catch {
      return undefined;
    }
    const key = candidateKey(target.spec.app, target.instance);
    // Belt and braces: a resolver that ignores `exclude` must not loop forever.
    if (ctx.tried.includes(key)) return undefined;
    const { autonomy, timeoutMs, fingerprint } = this.resolve(target, ctx.options);
    return {
      ...ctx,
      attemptId: newId("att"),
      seq: ctx.seq + 1,
      target,
      fingerprint,
      autonomy,
      timeoutMs,
      tried: [...ctx.tried, key],
    };
  }

  /** Authority and budget for one target: options may narrow the ceiling only. */
  private resolve(
    target: Target,
    options: RunOptions | undefined,
  ): { autonomy: Autonomy; timeoutMs: number; fingerprint: string } {
    const autonomy = clampAutonomy(
      options?.autonomy,
      ceilingFor(this.db, target.spec.app),
      target.spec.defaultAutonomy,
    );
    return {
      autonomy,
      timeoutMs: options?.timeoutMs ?? target.spec.defaultTimeoutMs,
      // Autonomy is part of the execution-target identity: the same model at a
      // different authority level is not interchangeable evidence.
      fingerprint: `${target.targetFingerprint}+${autonomy}`,
    };
  }

  /**
   * One transaction: the finished attempt, and either the run's terminal status
   * or the failover attempt that continues it. The successor is inserted
   * already `running` so the run is never momentarily idle, and it inherits the
   * concurrency slot the finished attempt just released.
   */
  private commit(
    ctx: AttemptCtx,
    res: ExecResult,
    o: { status: RunStatus; error: string | null; next: AttemptCtx | undefined },
  ): AttemptCtx | undefined {
    const now = nowIso();
    return withBusyRetry(() =>
      this.db.transaction(() => {
        // The outcome is recorded either way, but a cancellation that landed
        // while this attempt was finishing stands: the caller stopped the run,
        // and 'succeeded' would overwrite that with a lie.
        this.db
          .query(
            `UPDATE attempts SET
               status = CASE WHEN status IN ('queued','running') THEN ? ELSE status END,
               exit_code = ?, output = ?, raw_tail = ?, error = ?, session_ref = ?, finished_at = ?
             WHERE id = ?`,
          )
          .run(
            o.status,
            res.exitCode ?? null,
            res.output === undefined ? null : head(res.output, MAX_OUTPUT_CHARS),
            res.rawTail ? tail(res.rawTail, MAX_RAW_TAIL_CHARS) : null,
            o.error,
            res.sessionRef ?? null,
            now,
            ctx.attemptId,
          );
        // Cancellation lands between the attempt finishing and this commit:
        // failing over would resurrect a run the caller already stopped.
        const live =
          this.db
            .query<{ status: RunStatus }, [string]>("SELECT status FROM runs WHERE id = ?")
            .get(ctx.runId)?.status === "running";
        if (!o.next || !live) {
          this.db
            .query(
              "UPDATE runs SET status = ?, updated_at = ? WHERE id = ? AND status IN ('queued','running')",
            )
            .run(o.status, now, ctx.runId);
          return undefined;
        }
        this.db
          .query(
            "INSERT INTO attempts (id, run_id, seq, target, status, started_at, owner_pid) VALUES (?, ?, ?, ?, 'running', ?, ?)",
          )
          .run(o.next.attemptId, ctx.runId, o.next.seq, o.next.fingerprint, now, process.pid);
        // The run now belongs to the instance actually carrying it — resumes
        // and session affinity follow the attempt that answers.
        this.db
          .query("UPDATE runs SET app = ?, slug = ?, instance = ?, updated_at = ? WHERE id = ?")
          .run(o.next.target.spec.app, o.next.target.slug, o.next.target.instance, now, ctx.runId);
        return o.next;
      })(),
    );
  }

  /**
   * Inherited environment + the instance's overlay + the incremented hop count.
   * Nothing is scrubbed: Baton is not more special than a shell (PLAN.md §Identity).
   */
  private calleeEnv(ctx: AttemptCtx): Record<string, string | undefined> {
    return {
      ...this.env,
      ...(ctx.overlay ?? this.overlay(ctx.target.spec.app, ctx.target.instance)),
      [HOPS_ENV]: String(ctx.depth + 1),
    };
  }

  /**
   * An instance's env overlay. `strict` is for session affinity: a resume that
   * cannot find the definition must fail rather than run somewhere else, while
   * a fresh run's selection already vetted the instance and only reads it here.
   */
  private overlay(
    app: string,
    instance: string,
    opts: { strict?: boolean } = {},
  ): Record<string, string> {
    if (instance === DEFAULT_INSTANCE) return {};
    const row = this.db
      .query<{ env: string }, [string, string]>(
        "SELECT env FROM instances WHERE app = ? AND name = ?",
      )
      .get(app, instance);
    if (!row) {
      if (opts.strict) throw vanishedInstance(app, instance, "is no longer defined in this scope");
      return {};
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(row.env);
    } catch {
      // Falls through to the unusable-overlay branch below.
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      if (opts.strict) throw vanishedInstance(app, instance, "has an unusable env overlay");
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
    );
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
    runId: string;
    attemptId: string;
    fingerprint: string;
    model: string;
    app: string;
    slug: string;
    instance: string;
    prompt: string;
    cwd: string;
    category?: string;
    idempotencyKey?: string;
    /** Null for runs no key can dedup onto (a resume is never idempotent). */
    payloadHash: string | null;
    /** Resolved authority and budget, plus `resumed_from` on a resume. */
    options: Record<string, unknown>;
  }): void {
    const now = nowIso();
    // BEGIN IMMEDIATE: the admission count and the insert that consumes a slot
    // must not interleave with another process doing the same.
    this.db
      .transaction(() => {
        const cap = this.maxConcurrent();
        // 'queued' counts too: an attempt is inserted queued and only then
        // flipped to running, so counting 'running' alone lets two processes
        // in the gap both pass a cap of one.
        const running =
          this.db
            .query<{ n: number }, []>(
              "SELECT COUNT(*) AS n FROM attempts WHERE status IN ('queued','running')",
            )
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
            a.idempotencyKey ?? null,
            a.payloadHash,
            a.model,
            a.app,
            a.slug,
            a.instance,
            a.prompt,
            a.cwd,
            a.category ?? null,
            JSON.stringify(a.options),
            POLICY_VERSION,
            now,
            now,
          );
        this.db
          .query(
            "INSERT INTO attempts (id, run_id, seq, target, status, owner_pid) VALUES (?, ?, 1, ?, 'queued', ?)",
          )
          .run(a.attemptId, a.runId, a.fingerprint, process.pid);
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

  /** The exact target the original run used; never a fresh selection. */
  private pin(ref: PinnedRef): Target {
    return this.resolver.pinned ? this.resolver.pinned(ref) : targetFor(ref, this.db);
  }

  /**
   * The handle the app itself minted for this run's session, off its LAST
   * attempt — the one that actually holds the state. Anything else is a run
   * that cannot be continued, and saying so plainly beats a CLI error.
   */
  private sessionRefOf(runId: string): string {
    const row = this.db
      .query<{ session_ref: string | null; status: RunStatus }, [string]>(
        "SELECT session_ref, status FROM attempts WHERE run_id = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(runId);
    const ref = row?.session_ref;
    if (!ref) {
      throw new Error(
        `Cannot resume run '${runId}': its last attempt (${row?.status ?? "none recorded"}) reported no session handle, so the app has nothing to continue. Start a new run instead.`,
      );
    }
    if (!SESSION_REF.test(ref)) {
      throw new Error(
        `Cannot resume run '${runId}': the recorded session handle is not a plain identifier, so Baton refuses to pass it to the CLI.`,
      );
    }
    return ref;
  }

  /** Recursion guard, shared by every entry point that launches a callee. */
  private guardHops(): number {
    const depth = this.hopDepth();
    const maxHops = this.maxHops();
    if (depth >= maxHops) {
      throw new Error(
        `Refusing to delegate: this process is already ${depth} delegation hop(s) deep (${HOPS_ENV}=${depth}) and the '${SETTING_MAX_HOPS}' setting is ${maxHops}. Raise it with 'baton set ${SETTING_MAX_HOPS} <n>' if this chain is intended.`,
      );
    }
    return depth;
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

/**
 * The resume invocation as a one-off spec: only the argv template differs, so
 * prompt delivery, extraction, the session handle and the failure patterns are
 * literally the ones the first attempt used. `{sessionRef}` is substituted here
 * because it is run state; every other placeholder stays the executor's job.
 */
function resumeSpec(spec: AdapterSpec, sessionRef: string): AdapterSpec {
  const argv = spec.resume?.argv;
  if (!argv) throw new Error(`Adapter '${spec.app}' declares no resume invocation.`);
  return {
    ...spec,
    invoke: {
      ...spec.invoke,
      argv: argv.map((element) => element.replaceAll("{sessionRef}", sessionRef)),
    },
  };
}

/** What a resumed run inherits from the run it continues, ignoring the rest. */
function inheritedOptions(optionsJson: string): RunOptions {
  const parsed = parseOptions(optionsJson);
  const autonomy = parsed?.["autonomy"];
  const timeoutMs = parsed?.["timeoutMs"];
  return {
    ...(typeof autonomy === "string" && (AUTONOMY_ORDER as string[]).includes(autonomy)
      ? { autonomy: autonomy as Autonomy }
      : {}),
    ...(typeof timeoutMs === "number" && timeoutMs > 0 ? { timeoutMs } : {}),
  };
}

function parseOptions(optionsJson: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(optionsJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function vanishedInstance(app: string, instance: string, why: string): Error {
  return new Error(
    `Cannot resume: instance '${candidateKey(app, instance)}' ${why}, and the session lives in that instance's config dir. Re-add it with 'baton instance add ${app} ${instance} --env ...' or start a fresh run.`,
  );
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
  options: string;
  created_at: string;
  updated_at: string;
}

/** The run a resume continues: everything but the prompt comes from here. */
interface OriginRow {
  status: RunStatus;
  model: string;
  app: string;
  slug: string;
  instance: string;
  cwd: string;
  category: string | null;
  options: string;
}

interface AttemptRow {
  id: string;
  seq: number;
  target: string;
  status: RunStatus;
  exit_code: number | null;
  output: string | null;
  error: string | null;
  session_ref: string | null;
  started_at: string | null;
  finished_at: string | null;
}

/**
 * The run's answer is the LAST attempt's: a failover chain ends the moment one
 * succeeds, so any earlier attempt is a refused one whose output would be a
 * lie. The chain itself stays visible in `attempts`.
 */
function toView(run: RunRow, attempts: AttemptRow[]): RunView {
  const last = attempts[attempts.length - 1];
  const resumedFrom = parseOptions(run.options)?.[RESUMED_FROM];
  return {
    ...(typeof resumedFrom === "string" ? { resumedFrom } : {}),
    runId: run.id,
    status: run.status,
    model: run.model,
    app: run.app,
    slug: run.slug,
    instance: run.instance,
    ...(last?.status === "succeeded" && last.output ? { output: last.output } : {}),
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
    ...(a.session_ref ? { sessionRef: a.session_ref } : {}),
    ...(a.started_at ? { startedAt: a.started_at } : {}),
    ...(a.finished_at ? { finishedAt: a.finished_at } : {}),
  };
}

/**
 * The attempt's error, saying plainly when an admission failure had nowhere
 * left to go — otherwise "rate limited" reads as the whole story when the real
 * one is that the pool is spent.
 */
function failureText(
  res: ExecResult,
  o: { refused: boolean; failedOver: boolean; resumed: boolean },
): string | null {
  if (!o.refused || o.failedOver) return res.error ?? null;
  const why = o.resumed
    ? "a resumed run stays on the instance holding its session, so admission was not retried elsewhere"
    : "no other instance was eligible (each one is already attempted or cooling down)";
  return `${res.error ?? "admission failed"} — admission was refused and ${why}`;
}

function deduped(view: RunView): { view: RunView; settled: Promise<void> } {
  return { view: { ...view, deduplicated: true }, settled: Promise.resolve() };
}

interface OrphanRow {
  id: string;
  run_id: string;
  pid: number | null;
  owner_pid: number | null;
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
