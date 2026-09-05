import { spawn, type ChildProcess } from "node:child_process";
import type { AdapterSpec, ExecRequest, ExecResult, ExtractSpec } from "./types.ts";

/**
 * The only place Baton spawns a callee CLI. Environment-transparent
 * (PLAN.md §Identity): req.env is passed verbatim — nothing added, nothing
 * scrubbed. argv is an array built from the declarative spec, never a shell
 * string. The child is detached so it leads its own process group, which lets
 * a timeout kill the whole tree (`kill(-pid)`), not just the CLI wrapper.
 */

const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
/** Time between SIGTERM and SIGKILL of the callee's process group. */
const KILL_GRACE_MS = 5_000;
/** Overall budget for a group to be verifiably dead, SIGTERM to last poll. */
const KILL_DEADLINE_MS = 10_000;
const KILL_POLL_MS = 100;
/** Head of stdout kept beside the tail, so a first-line session id survives the cap. */
const SESSION_HEAD_BYTES = 64 * 1024;
const STDERR_IN_ERROR_CHARS = 500;
/** How much of a terminal error event is quoted in the extraction error. */
const ERROR_EVENT_CHARS = 500;

export async function executeAdapter(req: ExecRequest): Promise<ExecResult> {
  const started = Date.now();
  const cap = req.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const stdout = new Tail(cap);
  const stdoutHead = new Head(SESSION_HEAD_BYTES);
  const stderr = new Tail(cap);

  const flags = req.spec.autonomyFlags[req.autonomy];
  if (flags === undefined) {
    // Running anyway would silently execute at the app's own default authority,
    // which is exactly the ceiling violation the autonomy contract forbids.
    return {
      ok: false,
      started: false,
      exitCode: null,
      timedOut: false,
      rawTail: "",
      error: `adapter '${req.spec.app}' cannot run at autonomy '${req.autonomy}' (supported: ${Object.keys(req.spec.autonomyFlags).join(", ") || "none"})`,
      durationMs: Date.now() - started,
    };
  }

  let child: ChildProcess;
  try {
    // The registry resolved and verified an absolute path; spawning the bare
    // name instead would let an instance's PATH overlay swap the binary.
    child = spawn(req.binaryPath ?? req.spec.binary, buildArgv(req, flags), {
      cwd: req.cwd,
      env: req.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    return {
      ok: false,
      started: false,
      exitCode: null,
      timedOut: false,
      rawTail: "",
      error: `spawn failed: ${message(err)}`,
      durationMs: Date.now() - started,
    };
  }

  if (child.pid !== undefined) req.onSpawn?.(child.pid);

  return await new Promise<ExecResult>((resolve) => {
    let timedOut = false;
    let spawnError: string | undefined;
    let settled = false;
    /** Set on timeout; the terminal result waits for it (sol#1: a descendant
     * that ignores SIGTERM must be dead before we report the run finished). */
    let termination: Promise<KillOutcome> | undefined;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      const pid = child.pid;
      if (pid === undefined) return;
      termination = killProcessGroup(pid, {
        fallback: (signal) => {
          try {
            child.kill(signal);
          } catch {
            // Already gone.
          }
        },
      });
      // The group may outlive its stdio pipes; don't wait on "close" forever.
      void termination.then(() => finish(null));
    }, req.timeoutMs);

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      const emit = (killError?: string): void => {
        resolve(
          buildResult({
            req,
            stdout: stdout.text(),
            stdoutHead: stdoutHead.text(),
            stdoutTruncated: stdout.truncated,
            stderr: stderr.text(),
            exitCode,
            timedOut,
            spawnError,
            killError,
            durationMs: Date.now() - started,
          }),
        );
      };
      if (termination) termination.then((o) => emit(o.why), () => emit());
      else emit();
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      stdoutHead.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (err) => {
      spawnError = `spawn failed: ${message(err)}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));

    const stdin = child.stdin;
    if (stdin) {
      // The callee may exit without draining stdin; EPIPE is not our failure.
      stdin.on("error", () => {});
      stdin.end(req.spec.invoke.promptVia === "stdin" ? req.prompt : undefined);
    }
  });
}

export type FailureClass = "admission" | "failure";

/**
 * How a failed attempt may be treated. "admission" is the only class that
 * earns a cooldown and a replay of the prompt on another instance, so it
 * demands two things at once: an admission pattern matched AND nothing in the
 * output says the callee already started working. A rate-limit notice printed
 * after four minutes of edits reads exactly like one printed at the door —
 * only the surrounding stream tells them apart, and when in doubt the run
 * fails instead of failing over (PLAN.md §Failover on admission failure only).
 */
export function classifyFailure(spec: AdapterSpec, res: ExecResult): FailureClass {
  const haystack = `${res.rawTail}\n${res.error ?? ""}`.toLowerCase();
  const matches = (patterns: string[] | undefined): boolean =>
    (patterns ?? []).some(
      (pattern) => pattern.length > 0 && haystack.includes(pattern.toLowerCase()),
    );
  if (!matches(spec.admissionFailurePatterns)) return "failure";
  return matches(spec.workStartedPatterns) ? "failure" : "admission";
}

/** Did this failure look like a rejection *before any work started*? */
export function isAdmissionFailure(spec: AdapterSpec, res: ExecResult): boolean {
  return classifyFailure(spec, res) === "admission";
}

function buildArgv(req: ExecRequest, flags: string[]): string[] {
  const { invoke } = req.spec;
  const viaArgv = invoke.promptVia === "argv";
  const out: string[] = [];
  let placed = false;

  for (const element of invoke.argv) {
    if (element === "{autonomyFlags}") {
      placed = true;
      out.push(...flags);
      continue;
    }
    if (element === "{prompt}" && !viaArgv) continue; // delivered on stdin
    out.push(
      element.replaceAll("{slug}", req.slug).replaceAll("{prompt}", viaArgv ? req.prompt : ""),
    );
  }
  if (!placed) out.push(...flags);
  return out;
}

interface Outcome {
  req: ExecRequest;
  stdout: string;
  /** First SESSION_HEAD_BYTES of stdout, kept for sessionRef extraction. */
  stdoutHead: string;
  stdoutTruncated: boolean;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: string;
  /** Set when the process group could not be confirmed dead. */
  killError?: string;
  durationMs: number;
}

function buildResult(o: Outcome): ExecResult {
  const rawTail = o.stderr ? `${o.stdout}\n--- stderr ---\n${o.stderr}` : o.stdout;
  // Best-effort and outcome-independent: a session id is most valuable on the
  // runs that did not finish, which are exactly the ones we may want to resume.
  // Verbose runs push the session line (typically the first) out of the tail,
  // so search head+tail — the answer still comes from the tail alone.
  const sessionSource = o.stdoutTruncated ? `${o.stdoutHead}\n${o.stdout}` : o.stdout;
  const session = o.req.spec.sessionRef && extract(o.req.spec.sessionRef, sessionSource);
  const base = {
    // A spawn error means the process never ran; anything else got that far.
    started: !o.spawnError,
    exitCode: o.exitCode,
    timedOut: o.timedOut,
    rawTail,
    durationMs: o.durationMs,
    ...(session?.ok ? { sessionRef: session.value } : {}),
  };

  if (o.timedOut) {
    const kill = o.killError ? `; ${o.killError}` : "";
    return { ...base, ok: false, error: `timed out after ${o.req.timeoutMs}ms${kill}` };
  }
  if (o.spawnError) {
    return { ...base, ok: false, exitCode: null, error: o.spawnError };
  }
  if (o.exitCode !== 0) {
    const tail = o.stderr.trim().slice(-STDERR_IN_ERROR_CHARS);
    return {
      ...base,
      ok: false,
      error: `exited with code ${o.exitCode}${tail ? `: ${tail}` : ""}`,
    };
  }
  const extracted = extract(o.req.spec.invoke.extract, o.stdout);
  if (!extracted.ok) {
    return { ...base, ok: false, error: `extraction failed: ${extracted.why}` };
  }
  return { ...base, ok: true, output: extracted.value };
}

type Extracted = { ok: true; value: string } | { ok: false; why: string };

function extract(spec: ExtractSpec, stdout: string): Extracted {
  switch (spec.kind) {
    case "text":
      return finalize(stdout);
    case "json": {
      let doc: unknown;
      try {
        doc = JSON.parse(stdout);
      } catch {
        return { ok: false, why: "stdout is not valid JSON" };
      }
      const value = dotPath(doc, spec.path);
      if (value === undefined) return { ok: false, why: `path "${spec.path}" missing in JSON` };
      return finalize(stringify(value));
    }
    case "jsonl": {
      const records = parseJsonl(stdout);
      if (records.length === 0) return { ok: false, why: "no parseable JSON lines in stdout" };
      if (spec.errorWhen) {
        // Checked before the answer is picked: apps that stream text and then
        // fail upstream exit 0 with a usable-looking last text part.
        const { path, equals } = spec.errorWhen;
        const failed = records.find((r) => {
          const v = dotPath(r, path);
          return v !== undefined && String(v) === equals;
        });
        if (failed !== undefined) {
          return { ok: false, why: `error event: ${clip(stringify(failed), ERROR_EVENT_CHARS)}` };
        }
      }
      let matches = records;
      if (spec.where) {
        const { path, equals } = spec.where;
        matches = records.filter((r) => {
          const v = dotPath(r, path);
          return v !== undefined && String(v) === equals;
        });
        if (matches.length === 0) {
          return { ok: false, why: `no JSONL record where ${path} == ${equals}` };
        }
      }
      const record = spec.take === "first" ? matches[0] : matches[matches.length - 1];
      const value = dotPath(record, spec.path);
      if (value === undefined) {
        return { ok: false, why: `path "${spec.path}" missing in ${spec.take} matching JSONL record` };
      }
      return finalize(stringify(value));
    }
  }
}

function parseJsonl(stdout: string): unknown[] {
  const out: unknown[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Agent CLIs interleave banners with their JSONL; skip unparseable lines.
    }
  }
  return out;
}

/** Dot-path over nested objects; numeric segments index arrays. */
export function dotPath(root: unknown, path: string): unknown {
  let cursor = root;
  for (const segment of path.split(".")) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      cursor = cursor[index];
    } else if (typeof cursor === "object") {
      cursor = (cursor as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function finalize(value: string): Extracted {
  const trimmed = value.trim();
  return trimmed ? { ok: true, value: trimmed } : { ok: false, why: "empty result" };
}

export interface KillOptions {
  /** Time the group gets to exit on SIGTERM before SIGKILL. */
  graceMs?: number;
  /** Overall budget; past it we report the group as possibly alive. */
  deadlineMs?: number;
  pollMs?: number;
  /** Single-process kill used when the group signal is not deliverable. */
  fallback?: (signal: NodeJS.Signals) => void;
}

export interface KillOutcome {
  /** True only when kill(-pid, 0) says the group is gone. */
  dead: boolean;
  /** Why we could not confirm death, for honest error reporting. */
  why?: string;
}

/**
 * Terminate a whole process group and wait until it is verifiably dead:
 * SIGTERM → poll → SIGKILL → poll. Shared by the executor's timeout path and
 * by supervisor/CLI/MCP cancellation so every teardown has the same semantics.
 */
export async function killProcessGroup(pid: number, opts: KillOptions = {}): Promise<KillOutcome> {
  if (!Number.isInteger(pid) || pid <= 1) {
    return { dead: false, why: `refusing to signal process group ${pid}` };
  }
  const pollMs = opts.pollMs ?? KILL_POLL_MS;
  const deadline = Date.now() + (opts.deadlineMs ?? KILL_DEADLINE_MS);
  const graceEnd = Math.min(Date.now() + (opts.graceMs ?? KILL_GRACE_MS), deadline);

  signalGroup(pid, "SIGTERM", opts.fallback);
  if (await waitForDeath(pid, graceEnd, pollMs)) return { dead: true };

  signalGroup(pid, "SIGKILL", opts.fallback);
  if (await waitForDeath(pid, deadline, pollMs)) return { dead: true };

  return { dead: false, why: `process group ${pid} still alive after SIGKILL` };
}

async function waitForDeath(pid: number, until: number, pollMs: number): Promise<boolean> {
  for (;;) {
    if (!groupAlive(pid)) return true;
    if (Date.now() >= until) return !groupAlive(pid);
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(1, until - Date.now()))));
  }
}

/** ESRCH is the only answer that proves the group is gone; EPERM means alive. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals, fallback: KillOptions["fallback"]): void {
  try {
    process.kill(-pid, signal); // negative pid => the whole process group
  } catch {
    fallback?.(signal);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Byte-capped buffer that keeps the tail, so late output survives the cap. */
class Tail {
  private chunks: Buffer[] = [];
  private size = 0;
  /** True once bytes were dropped, i.e. the head is no longer in this buffer. */
  truncated = false;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.cap) {
      this.truncated = true;
      const first = this.chunks[0];
      if (!first) break;
      const over = this.size - this.cap;
      if (first.length <= over) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(over);
        this.size -= over;
      }
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/** Byte-capped buffer that keeps the head, so early output survives the cap. */
class Head {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    const room = this.cap - this.size;
    if (room <= 0) return;
    this.chunks.push(chunk.length <= room ? chunk : chunk.subarray(0, room));
    this.size += Math.min(chunk.length, room);
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}
