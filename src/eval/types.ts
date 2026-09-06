/**
 * Eval foundation (PLAN.md §Evaluation, ratings, profiles). Storage roles are
 * strictly separated: grades (raw, private ring buffer alongside runs),
 * accumulator (observed evidence only), priors (explicit, provenance-tagged),
 * ratings.yaml (derived projection — display/share only, never read back).
 */

/** Grades are 1–5, consumer-assigned after *using* the result. */
export type Grade = number;

/**
 * Decayed sufficient statistics for one (execution target, category).
 * Write-side decay-forward (PLAN.md §Decay): on each event, decay the
 * aggregate from as_of to now by 2^(−Δt/half-life) (sum_w2 by the square),
 * add the event weighted by 2^(−(now − t_run)/half-life), set as_of = now.
 */
export interface Accumulator {
  target: string;
  model: string;
  category: string;
  /** Σ w·grade */
  sumWg: number;
  /** Σ w */
  sumW: number;
  /** Σ w² — for nEff = (Σw)²/Σw² */
  sumW2: number;
  /** Raw (undecayed) event count. */
  n: number;
  /** ISO timestamp the sums are current as of. */
  asOf: string;
}

export interface Prior {
  profile: string;
  /** Canonical model id — priors never attach to targets. */
  model: string;
  category: string;
  /** On the grade scale (1–5). */
  mean: number;
  /** Pseudo-observations; capped at PRIOR_WEIGHT_CAP on write. */
  weight: number;
  /** Provenance: 'seeded' | 'imported:<name>'. */
  source: string;
  asOf: string;
}

/** A wrong seed must not steer routing for months (PLAN.md §Seeded priors). */
export const PRIOR_WEIGHT_CAP = 10;

/** Pseudo-observations a seed or import gets when it does not say. */
export const DEFAULT_PRIOR_WEIGHT = 5;

export const DEFAULT_HALF_LIFE_DAYS = 90;

/** Effective rating shown per model: prior and observed kept separate. */
export interface EffectiveRating {
  model: string;
  category: string;
  /** Observed decayed mean, or null with no evidence. */
  observed: number | null;
  nEff: number;
  /** Active profile's prior, or null. */
  prior: number | null;
  priorWeight: number;
  /** Shrinkage blend of both, or null when neither exists. */
  blended: number | null;
}

/** Settings keys (settings table). */
export const SETTING_HALF_LIFE_DAYS = "half_life_days";
export const SETTING_ACTIVE_PROFILE = "active_profile";
/** Multiplier on the active profile's prior weights when blending. */
export const SETTING_PROFILE_WEIGHT = "profile_weight";
/**
 * Monotonic revision, incremented in the same transaction as every
 * grades/accumulator/priors commit. The ratings.yaml publisher embeds it as
 * source_revision and only renames over an older revision (PLAN.md
 * §Publication protocol).
 */
export const SETTING_RATINGS_REVISION = "ratings_revision";
