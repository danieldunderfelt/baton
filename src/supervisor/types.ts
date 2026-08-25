import type { Autonomy } from "../adapters/types.ts";

/**
 * Logical run → attempts (PLAN.md §Execution). A run is the caller's request;
 * each execution is an attempt. Phase 1: one attempt per run (pools/failover
 * arrive in phase 2), but the schema and views already carry the split.
 */

export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timeout"
  | "cancelled"
  | "orphaned";

export interface RunOptions {
  autonomy?: Autonomy;
  timeoutMs?: number;
}

export interface RunRequest {
  model: string;
  prompt: string;
  /** Defaults to the inherited host cwd. */
  cwd?: string;
  /** Explicit instance selection; default = the inherited environment as-is. */
  instance?: string;
  category?: string;
  options?: RunOptions;
  /** Payload-bound caller key: a retry with the same key returns the existing run. */
  idempotencyKey?: string;
}

/**
 * Continue a run's session (PLAN.md §Session affinity). The original run
 * decides everything except the new prompt: model, app, slug, instance and cwd
 * are copied, because the session state lives in that instance's config dir.
 */
export interface ResumeRequest {
  runId: string;
  prompt: string;
  /** Narrows what the original run resolved; the scope ceiling still clamps. */
  options?: RunOptions;
}

export interface AttemptView {
  id: string;
  seq: number;
  /**
   * Execution-target fingerprint, `<app>:<instance>/<slug>@a<adapterVersion>+<autonomy>`:
   * the registry mints the prefix, the supervisor appends the resolved autonomy
   * (the same model at another authority level is not interchangeable evidence).
   */
  target: string;
  status: RunStatus;
  exitCode: number | null;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  /**
   * The app's own session handle, when it reported one. Surfaced so a caller
   * can see that a failed run left something resumable — the decision to
   * replay is the caller's, never Baton's.
   */
  sessionRef?: string;
}

export interface RunView {
  runId: string;
  status: RunStatus;
  model: string;
  app: string;
  slug: string;
  instance: string;
  /** Extracted answer of the successful attempt. */
  output?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  attempts: AttemptView[];
  /** True when this call deduplicated onto an existing run via idempotency key. */
  deduplicated?: boolean;
  /** Set when this run continues another run's session (resumeRun). */
  resumedFrom?: string;
}

/** Key inside a run's `options` JSON naming the run it resumed. */
export const RESUMED_FROM = "resumed_from";

/**
 * Keys inside a run's `options` JSON pinning the adapter revision the run
 * executed under. A session handle only means something to the invocation that
 * minted it, so a resume must check that the app's adapter has not been
 * replaced underneath it (PLAN.md §Session affinity). Built-ins are identified
 * by `adapterVersion` alone — they are pinned in the binary and bump it when
 * they change — while a discovered spec is content-addressed, so its digest is
 * recorded too.
 */
export const ADAPTER_VERSION = "adapter_version";
export const ADAPTER_DIGEST = "adapter_digest";

/** Recursion guard: injected into every callee environment. */
export const HOPS_ENV = "BATON_HOPS";
export const DEFAULT_MAX_HOPS = 2;

/** Settings keys (settings table). */
export const SETTING_MAX_HOPS = "max_hops";
/** Per-scope cap on attempts running at once (PLAN.md §Execution: resource limits). */
export const SETTING_MAX_CONCURRENT = "max_concurrent";
export const DEFAULT_MAX_CONCURRENT = 4;
/** Per-app authority ceiling: key `max_autonomy:<app>`, value an Autonomy. */
export const SETTING_MAX_AUTONOMY_PREFIX = "max_autonomy:";
