/**
 * The declarative adapter format (PLAN.md §Agentic discovery — same format
 * for built-ins). Safe by construction: argv arrays never shell strings,
 * prompt via stdin where possible, bounded declarative output extraction.
 * Built-in adapters are TS constants; discovered adapters (phase 3) are the
 * same shape stored quarantined in SQLite.
 */

export type Autonomy = "readonly" | "edits" | "full";

export const AUTONOMY_ORDER: Autonomy[] = ["readonly", "edits", "full"];

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
  /** App id: "codex", "kimi", "claude-code", "opencode". */
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
  defaultAutonomy: Autonomy;
  defaultTimeoutMs: number;
  /**
   * Case-insensitive substrings identifying an ADMISSION failure
   * (rate limit / auth rejection before work starts) in stderr/stdout —
   * used for pool cooldown (phase 2) and clearer phase-1 errors.
   */
  admissionFailurePatterns: string[];
}

/** Result of running an adapter once. Reliability data lives here. */
export interface ExecResult {
  ok: boolean;
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
