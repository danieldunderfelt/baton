/**
 * The declarative adapter format (PLAN.md §Agentic discovery — same format
 * for built-ins). Safe by construction: argv arrays never shell strings,
 * prompt via stdin where possible, bounded declarative output extraction.
 * Built-in adapters are TS constants; discovered adapters (phase 3) are the
 * same shape stored quarantined in SQLite.
 */

export type Autonomy = "readonly" | "edits" | "full";

export const AUTONOMY_ORDER: Autonomy[] = ["readonly", "edits", "full"];

/**
 * The instance meaning "the inherited environment as-is". Always exists, for
 * every app — including the ones with no `identityEnv`, where it is the only
 * instance there can be. It lives here, with the adapter vocabulary, because
 * both the registry and discovery's canary have to name it.
 */
export const DEFAULT_INSTANCE = "default";

export interface RouteSpec {
  /** Canonical model id, e.g. "kimi-k3", "gpt-5.6-sol". */
  model: string;
  /** App-native slug, e.g. "kimi-code/k3". */
  slug: string;
}

export type ExtractSpec =
  /** Whole stdout, trimmed. */
  | { kind: "text" }
  /** stdout is a single JSON document; pick a dot-path. */
  | { kind: "json"; path: string }
  /** stdout is JSON-lines; filter, then pick a dot-path from first/last match. */
  | {
      kind: "jsonl";
      where?: { path: string; equals: string };
      /**
       * Terminal-error line. If any record matches, extraction fails with that
       * record as the detail — an error event dominates whatever text came
       * before it, so a stream that answered halfway and then died upstream is
       * a failure, not a partial success.
       */
      errorWhen?: { path: string; equals: string };
      path: string;
      take: "first" | "last";
    };

export interface InvokeSpec {
  /**
   * argv AFTER the binary. Placeholders substituted as single elements:
   *   {slug}   — the route's model slug
   *   {prompt} — only when promptVia === "argv"
   * The autonomy flag fragment is appended where "{autonomyFlags}" appears
   * (expanded in place, may be multiple elements) or at the end if absent.
   */
  argv: string[];
  promptVia: "stdin" | "argv";
  extract: ExtractSpec;
}

export interface AdapterSpec {
  /** App id: "codex", "kimi", "claude-code", "opencode", "cursor-agent". */
  app: string;
  adapterVersion: number;
  /** Executable name, resolved to an absolute path at detect time. */
  binary: string;
  /** Env var that relocates this app's identity/config, if any. */
  identityEnv?: string;
  models: RouteSpec[];
  invoke: InvokeSpec;
  /**
   * argv fragments per autonomy level. Missing level = level unsupported, and
   * the executor refuses to run rather than falling back to the app's default
   * authority (PLAN.md §Execution: options may narrow the ceiling, never raise it).
   */
  autonomyFlags: Partial<Record<Autonomy, string[]>>;
  /** Where the app's own session/thread id appears in stdout, for resume (phase 2). */
  sessionRef?: ExtractSpec;
  /**
   * How to continue a session the app already holds (PLAN.md §Session
   * affinity). argv AFTER the binary, same substitution rules as `invoke`
   * plus `{sessionRef}` — the handle `sessionRef` extracted from the run being
   * resumed, filled in by the supervisor because it is run state, not adapter
   * state. `promptVia` and `extract` are inherited from `invoke`: only the argv
   * template differs, so a resume goes through the identical executor pipeline.
   * Absent = this app has no verified non-interactive resume, and Baton refuses
   * to resume its runs rather than guess.
   */
  resume?: { argv: string[] };
  defaultAutonomy: Autonomy;
  defaultTimeoutMs: number;
  /**
   * Case-insensitive substrings identifying an ADMISSION failure
   * (rate limit / auth rejection before work starts) in stderr/stdout —
   * used for pool cooldown (phase 2) and clearer phase-1 errors.
   * Only ever consulted together with workStartedPatterns: see classifyFailure.
   */
  admissionFailurePatterns: string[];
  /**
   * Case-insensitive substrings whose presence in the raw output is positive
   * evidence the callee BEGAN WORKING (first stream event, tool call, message
   * part). Failover replays the prompt, so it is reserved for rejections before
   * any work happened (PLAN.md §Failover on admission failure only); one of
   * these markers vetoes the admission reading no matter what else matched.
   * Omitted/empty means "this app gives no such evidence" — which only makes
   * the classification stricter if its admission patterns cannot appear mid-run.
   */
  workStartedPatterns?: string[];
}

/** Result of running an adapter once. Reliability data lives here. */
export interface ExecResult {
  ok: boolean;
  /**
   * True once the callee process was actually spawned and ran. False for
   * pre-spawn refusals (unsupported autonomy) and spawn errors (ENOENT), which
   * are Baton-side facts and must not be charged to the target's reliability.
   */
  started: boolean;
  /** Extracted final answer when ok. */
  output?: string;
  exitCode: number | null;
  timedOut: boolean;
  /** Bounded tail of raw combined output, for debugging/reliability records. */
  rawTail: string;
  error?: string;
  durationMs: number;
  /** App-side session/thread id when the adapter exposes one (resume support). */
  sessionRef?: string;
}

export interface ExecRequest {
  spec: AdapterSpec;
  /**
   * Absolute path of the binary as verified by detect. Spawned instead of
   * spec.binary so an instance's PATH overlay cannot swap the executable.
   */
  binaryPath?: string;
  slug: string;
  prompt: string;
  cwd: string;
  /** Full callee environment (inherited + overlay + BATON_HOPS), pre-composed. */
  env: Record<string, string | undefined>;
  autonomy: Autonomy;
  timeoutMs: number;
  /** Max bytes of raw output retained (default supplied by executor). */
  maxOutputBytes?: number;
  /**
   * Called with the callee's pid (= its process-group id) the moment it exists.
   * The supervisor records it so cancellation and orphan recovery can act on the
   * group even if this process dies mid-run.
   */
  onSpawn?: (pid: number) => void;
}
