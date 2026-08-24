/**
 * Quota-aware cost (PLAN.md §Quota-aware cost) and instance pools
 * (PLAN.md §Instance pools). Subscriptions are flat-rate: the constraint is
 * quota-window headroom, not invented per-route cost numbers.
 */

/** User-owned, per (app, instance). Collected conversationally at onboarding. */
export type Preciousness = "burn" | "conserve" | "emergency";

export const PRECIOUSNESS_FACTOR: Record<Preciousness, number> = {
  burn: 1,
  conserve: 0.5,
  /** Only eligible when every non-emergency candidate is unavailable. */
  emergency: 0.05,
};

/** Settings key: `preciousness:<app>:<instance>` → Preciousness. */
export const SETTING_PRECIOUSNESS_PREFIX = "preciousness:";

/** Observed rolling windows per instance: 5-hour and weekly (Claude-style). */
export const WINDOW_SHORT_MS = 5 * 60 * 60 * 1000;
export const WINDOW_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface QuotaSnapshot {
  app: string;
  instance: string;
  /** Runs recorded in the short/weekly windows. */
  runsShort: number;
  runsWeek: number;
  /** Cooling down until (ISO), if an admission failure marked it. */
  coolingUntil?: string;
  /**
   * Relative headroom in [0, 1]: 1 = untouched, decreasing with recent use.
   * An estimate from run counts unless the CLI exposes real usage — honest
   * relative signal for spreading, not an absolute quota claim.
   */
  headroom: number;
}

export interface Pool {
  app: string;
  /** Instance names, order = stable tie-break preference. */
  members: string[];
}

/** Admission-failure cooldown: exponential backoff base/cap when the CLI
 * output carries no parseable reset time. */
export const COOLDOWN_BASE_MS = 5 * 60 * 1000;
export const COOLDOWN_CAP_MS = 6 * 60 * 60 * 1000;
