import type { Accumulator } from "./types.ts";

/**
 * The decay rule (PLAN.md §Decay), as pure math over the sufficient statistics.
 * No DB, no clock: every function takes the times it needs, so the write-side
 * (decay-forward on commit) and the read-side (residual decay to read time)
 * share one implementation and can be property-tested against brute force.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function halfLifeMs(days: number): number {
  return days * MS_PER_DAY;
}

/**
 * 2^(−age/half-life). Ages at or below zero — a future-dated run, a clock that
 * stepped back — weigh 1: evidence is never amplified for being "not yet old".
 * A non-finite age falls into the same branch rather than poisoning the sums.
 */
export function weightAt(ageMs: number, hlMs: number): number {
  return 2 ** (-(ageMs > 0 ? ageMs : 0) / hlMs);
}

export function decayFactor(fromIso: string, toIso: string, hlMs: number): number {
  return weightAt(Date.parse(toIso) - Date.parse(fromIso), hlMs);
}

/**
 * Decays the aggregate from its `as_of` to `toIso`: Σwg and Σw by the factor,
 * Σw² by its square (it is a sum of squared weights). `n` is a raw count and
 * does not decay. `as_of` never moves backwards — a decay to a time already
 * covered is a no-op, not a rewind that would double-decay the next event.
 */
export function decayAccumulator(acc: Accumulator, toIso: string, hlMs: number): Accumulator {
  const f = decayFactor(acc.asOf, toIso, hlMs);
  if (f === 1) return { ...acc, asOf: laterOf(acc.asOf, toIso) };
  return {
    ...acc,
    sumWg: acc.sumWg * f,
    sumW: acc.sumW * f,
    sumW2: acc.sumW2 * f * f,
    asOf: toIso,
  };
}

/**
 * Decay-forward, then add the event weighted from the *run's* time: a grade
 * that arrives late carries the weight its run has earned, not a fresh one.
 */
export function addGradeEvent(
  acc: Accumulator,
  grade: number,
  runAtIso: string,
  nowIso: string,
  hlMs: number,
): Accumulator {
  return applyGradeEvent(acc, grade, runAtIso, nowIso, hlMs, 1);
}

/**
 * The exact inverse of `addGradeEvent` for an event already folded in: the
 * weight is recomputed from the run time at `nowIso`, which is what that
 * event's original contribution has decayed to by now, so it cancels exactly.
 * Used to un-count a grade that is being replaced.
 */
export function removeGradeEvent(
  acc: Accumulator,
  grade: number,
  runAtIso: string,
  nowIso: string,
  hlMs: number,
): Accumulator {
  return applyGradeEvent(acc, grade, runAtIso, nowIso, hlMs, -1);
}

function applyGradeEvent(
  acc: Accumulator,
  grade: number,
  runAtIso: string,
  nowIso: string,
  hlMs: number,
  sign: 1 | -1,
): Accumulator {
  const decayed = decayAccumulator(acc, nowIso, hlMs);
  const w = weightAt(Date.parse(nowIso) - Date.parse(runAtIso), hlMs);
  return {
    ...decayed,
    sumWg: nonNegative(decayed.sumWg + sign * w * grade),
    sumW: nonNegative(decayed.sumW + sign * w),
    sumW2: nonNegative(decayed.sumW2 + sign * w * w),
    n: Math.max(0, decayed.n + sign),
  };
}

/** Effective sample size (Σw)²/Σw² — how many observations the evidence is worth. */
export function nEff(acc: Accumulator): number {
  return acc.sumW2 > 0 ? (acc.sumW * acc.sumW) / acc.sumW2 : 0;
}

/** Decayed mean grade, or null when there is no evidence left to speak of. */
export function mean(acc: Accumulator): number | null {
  return acc.sumW > EPSILON ? acc.sumWg / acc.sumW : null;
}

/**
 * Shrinkage toward the prior: the prior's weight is pseudo-observations on the
 * same scale as Σw, so evidence overtakes it as it accumulates. Either side may
 * be absent; with neither there is nothing to say.
 *
 * A side with no weight has no say — a muted prior (profile weight 0) or one
 * decayed to nothing is not an opinion, and returning its mean anyway would let
 * it route as if it were rated. Zero total weight is "unrated", i.e. null.
 */
export function blend(
  observedMean: number | null,
  observedSumW: number,
  priorMean: number | null,
  priorWeight: number,
): number | null {
  const obsW = observedMean === null || !(observedSumW > 0) ? 0 : observedSumW;
  const priW = priorMean === null || !(priorWeight > 0) ? 0 : priorWeight;
  const total = obsW + priW;
  if (total === 0) return null;
  return ((observedMean ?? 0) * obsW + (priorMean ?? 0) * priW) / total;
}

/** Floating-point residue after heavy decay is not evidence. */
const EPSILON = 1e-12;

function nonNegative(value: number): number {
  return value > 0 ? value : 0;
}

/**
 * The later of two instants. An aggregate's `as_of` is its clock and must never
 * rewind, so an event that arrives out of order — a replayed grade, a backdated
 * report, a clock that stepped back — is folded in at the aggregate's own time
 * rather than at the older one it claims (PLAN.md §Decay: read-side decay is a
 * common factor, which only holds while `as_of` is monotonic).
 */
export function laterOf(a: string, b: string): string {
  return Date.parse(b) > Date.parse(a) ? b : a;
}
