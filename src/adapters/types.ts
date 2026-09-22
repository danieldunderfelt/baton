import type { AdapterSpec, Autonomy } from "./schema.ts";
export { AUTONOMY_ORDER } from "./schema.ts";
export type {
  AdapterSpec,
  Autonomy,
  ExtractSpec,
  ModelsExtractSpec,
  InvokeSpec,
  ListModelsSpec,
  RouteSpec,
} from "./schema.ts";

/** The inherited account environment. Always exists. */
export const DEFAULT_INSTANCE = "default";

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
  /** Work-start evidence from the whole stream, retained beyond the raw tail. */
  workStarted?: boolean;
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
  /** Absent = no deadline; the callee runs until it exits or is cancelled. */
  timeoutMs?: number;
  /** Max bytes of raw output retained (default supplied by executor). */
  maxOutputBytes?: number;
  /**
   * Called with the callee's pid (= its process-group id) the moment it exists.
   * The supervisor records it so cancellation and orphan recovery can act on the
   * group even if this process dies mid-run.
   */
  onSpawn?: (pid: number) => void;
}
