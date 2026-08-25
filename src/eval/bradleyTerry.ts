import { BT_SHRINKAGE_WEIGHT, TIE_WEIGHT } from "./duelTypes.ts";
import type { BtEdge, BtPrior, BtRating } from "./duelTypes.ts";

/**
 * Regularized Bradley-Terry over log-strengths (PLAN.md §Evaluation: "shrinkage
 * to the canonical prior, identifiability anchored"). Every model gets a
 * shrinkage pseudo-edge against a fixed virtual anchor (theta 0), so sparse or
 * disconnected duel graphs stay numerically identified instead of diverging:
 * duel evidence moves a model away from its prior, never the reverse.
 *
 * Pure math only — no clock, no store. `asOf` is ignored; decay is applied
 * upstream before edges reach this fit, priors included (`btRatings` resolves
 * each prior's effective weight and calls this once per category).
 */

export interface FitOptions {
  shrinkageWeight?: number;
  maxIter?: number;
  tol?: number;
}

/** ln() never sees a non-positive strength, so theta can never go NaN/-Infinity. */
const EPSILON = 1e-12;
/** Fisher information of zero means "no information" — a huge but finite se. */
const FALLBACK_SE = 10;
/** The grade a theta of 0 stands for: no opinion either way. */
const NEUTRAL_GRADE = 3;

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** A prior mean on the 1–5 grade scale mapped onto log-strength; 3 is neutral. */
function priorToTheta(priorMean: number): number {
  return (priorMean - NEUTRAL_GRADE) * 0.5;
}

/** One comparison a model is party to: real duel edge or the shrinkage pseudo-edge. */
interface Comparison {
  /** Total mass of the comparison (winsA + winsB + ties, or anchor weight). */
  weight: number;
  /** Opponent strength index, or -1 for the fixed anchor (strength 1). */
  opponent: number;
}

/** The anchor pseudo-edge one model is fitted against. */
interface Anchor {
  weight: number;
  wins: number;
}

/**
 * Fits one rating per (model, category): categories are independent subgraphs,
 * so a model can be strong in one and weak in another. Models with no real
 * comparison mass and no weighted prior are excluded — nobody has an opinion
 * about them. `priors` is keyed by model and applies to every category in
 * `edges`, which is why the store-side entry point fits one category at a time.
 *
 * Deterministic by construction: models are sorted before any summation, so
 * floating-point accumulation order is stable across identical calls.
 */
export function fitBradleyTerry(
  edges: BtEdge[],
  priors: Map<string, BtPrior>,
  opts?: FitOptions,
): BtRating[] {
  const shrinkageWeight = opts?.shrinkageWeight ?? BT_SHRINKAGE_WEIGHT;
  const maxIter = opts?.maxIter ?? 500;
  const tol = opts?.tol ?? 1e-9;

  const categories = [...new Set(edges.map((e) => e.category))].sort();
  const priorModels = [...priors.keys()].filter((m) => (priors.get(m)?.weight ?? 0) > 0).sort();

  const ratings: BtRating[] = [];
  for (const category of categories) {
    ratings.push(...fitCategory(category, edges, priors, priorModels, shrinkageWeight, maxIter, tol));
  }
  return ratings;
}

function fitCategory(
  category: string,
  edges: BtEdge[],
  priors: Map<string, BtPrior>,
  priorModels: string[],
  shrinkageWeight: number,
  maxIter: number,
  tol: number,
): BtRating[] {
  const catEdges = edges.filter((e) => e.category === category);

  // Real comparison mass per model: Σw over the edges it is party to, plus the
  // Σw² each edge retained, so nEff can be the honest Kish (Σw)²/Σw² instead of
  // a raw decayed sum that calls ten faded duels one observation.
  const mass = new Map<string, number>();
  const mass2 = new Map<string, number>();
  for (const e of catEdges) {
    const w = edgeMass(e);
    if (w <= 0) continue;
    for (const m of [e.modelA, e.modelB]) {
      mass.set(m, (mass.get(m) ?? 0) + w);
      mass2.set(m, (mass2.get(m) ?? 0) + e.mass2);
    }
  }

  // Models with real mass or a prior that still carries weight.
  const modelSet = new Set<string>([...mass.keys(), ...priorModels]);
  const models = [...modelSet].sort();
  if (models.length === 0) return [];
  const index = new Map(models.map((m, i) => [m, i]));

  // Wins-equivalents and comparison lists per model. A tie is stored as one
  // directionless comparison and split TIE_WEIGHT each way HERE — the single
  // place that split happens, so one duel is one unit of mass.
  const wins = models.map(() => 0);
  const comps: Comparison[][] = models.map(() => []);
  for (const e of catEdges) {
    const total = edgeMass(e);
    const a = index.get(e.modelA);
    const b = index.get(e.modelB);
    if (a === undefined || b === undefined) continue;
    wins[a] = wins[a]! + e.winsA + TIE_WEIGHT * e.ties;
    wins[b] = wins[b]! + e.winsB + TIE_WEIGHT * e.ties;
    comps[a]!.push({ weight: total, opponent: b });
    comps[b]!.push({ weight: total, opponent: a });
  }

  // Shrinkage pseudo-edge against the fixed anchor. It always carries at least
  // `shrinkageWeight` of mass, of which the prior owns its resolved effective
  // weight and the remainder stays neutral (theta 0): a thin, stale or muted
  // prior degrades smoothly toward "no opinion" while the anchor keeps the fit
  // identified. A model without a prior is entirely neutral — an un-opinionated
  // target that duel evidence alone moves.
  const anchors: Anchor[] = models.map((m) => {
    const prior = priors.get(m);
    const priorW = prior && prior.weight > 0 ? prior.weight : 0;
    const weight = Math.max(shrinkageWeight, priorW);
    const p = priorW > 0 ? sigmoid(priorToTheta(prior!.mean)) : 0.5;
    return { weight, wins: priorW * p + (weight - priorW) * 0.5 };
  });
  for (let i = 0; i < models.length; i++) {
    wins[i] = wins[i]! + anchors[i]!.wins;
    comps[i]!.push({ weight: anchors[i]!.weight, opponent: -1 });
  }

  // MM iterations: simultaneous strength updates (the standard Bradley-Terry
  // MLE fixed point), with the anchor's strength pinned at exp(0) = 1.
  let strengths = models.map(() => 1);
  let converged = false;
  for (let iter = 0; iter < maxIter; iter++) {
    const next = strengths.slice();
    for (let i = 0; i < models.length; i++) {
      const s = strengths[i]!;
      let denom = 0;
      for (const c of comps[i]!) {
        const sOpp = c.opponent < 0 ? 1 : strengths[c.opponent]!;
        denom += c.weight / (s + sOpp);
      }
      // Defensive: included models always carry mass, but never divide by zero.
      if (denom > 0) next[i] = wins[i]! / denom;
    }
    let maxDelta = 0;
    for (let i = 0; i < models.length; i++) {
      const d = Math.abs(
        Math.log(Math.max(next[i]!, EPSILON)) - Math.log(Math.max(strengths[i]!, EPSILON)),
      );
      if (d > maxDelta) maxDelta = d;
    }
    strengths = next;
    if (maxDelta < tol) {
      converged = true;
      break;
    }
  }

  // Identifiability comes from the anchor alone: theta 0 IS the fixed neutral
  // opponent (grade 3), so thetas are reported as fitted, never recentered.
  // A post-fit recentering would drag a prior-only model off its prior whenever
  // OTHER models duel, and drift every theta as decay shifts the weights — the
  // two review findings this shape exists to prevent.
  const thetas = strengths.map((s) => Math.log(Math.max(s, EPSILON)));
  const nEffs = models.map((m) => kish(mass.get(m) ?? 0, mass2.get(m) ?? 0));
  const ses = standardErrors(catEdges, index, strengths, anchors);
  return models.map((m, i) => ({
    model: m,
    category,
    theta: thetas[i]!,
    se: ses[i]!,
    nEff: nEffs[i]!,
    converged,
  }));
}

/** One judged duel is one unit of mass, ties included. */
function edgeMass(e: BtEdge): number {
  return e.winsA + e.winsB + e.ties;
}

/** Effective sample size (Σw)²/Σw²: ten faded duels are ten observations. */
function kish(sumW: number, sumW2: number): number {
  return sumW2 > 0 ? (sumW * sumW) / sumW2 : 0;
}

/**
 * Posterior sds of the anchored thetas.
 *
 * The information matrix is built in full at the fitted strengths — off-diagonal
 * terms included, because two models that only ever duelled each other have
 * strongly correlated thetas and a diagonal-only reciprocal would report each of
 * them as if the other were known exactly. It is inverted (models per category
 * are few, so a plain Gauss-Jordan is the whole numerical apparatus needed);
 * each anchored theta's marginal sd is the square root of its diagonal entry.
 */
function standardErrors(
  catEdges: BtEdge[],
  index: Map<string, number>,
  strengths: number[],
  anchors: Anchor[],
): number[] {
  const n = strengths.length;
  const info: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (const e of catEdges) {
    const w = edgeMass(e);
    const i = index.get(e.modelA);
    const j = index.get(e.modelB);
    if (w <= 0 || i === undefined || j === undefined) continue;
    const v = pairInfo(w, strengths[i]!, strengths[j]!);
    info[i]![i]! += v;
    info[j]![j]! += v;
    info[i]![j]! -= v;
    info[j]![i]! -= v;
  }
  // The anchor pseudo-edges are what make this positive definite, i.e. what
  // makes a sparse or disconnected duel graph invertible at all.
  for (let i = 0; i < n; i++) info[i]![i]! += pairInfo(anchors[i]!.weight, strengths[i]!, 1);

  const cov = invert(info);
  if (!cov) return new Array<number>(n).fill(FALLBACK_SE);
  return strengths.map((_, i) => seFallback(cov, i));
}

function seFallback(cov: number[][], i: number): number {
  const own = cov[i]![i]!;
  return own > 0 && Number.isFinite(own) ? Math.sqrt(own) : FALLBACK_SE;
}

/** Fisher information of one comparison of mass w: w·p·(1−p) in theta space. */
function pairInfo(w: number, si: number, sj: number): number {
  const sum = si + sj;
  return sum > 0 ? (w * si * sj) / (sum * sum) : 0;
}



/** Gauss-Jordan with partial pivoting; null when the matrix is singular. */
function invert(m: number[][]): number[][] | null {
  const n = m.length;
  const a = m.map((row) => row.slice());
  const inv: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    }
    const p = a[pivot]![col]!;
    if (!Number.isFinite(p) || Math.abs(p) < EPSILON) return null;
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    [inv[col], inv[pivot]] = [inv[pivot]!, inv[col]!];
    const row = a[col]!;
    const irow = inv[col]!;
    for (let j = 0; j < n; j++) {
      row[j] = row[j]! / p;
      irow[j] = irow[j]! / p;
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r]![col]!;
      if (factor === 0) continue;
      for (let j = 0; j < n; j++) {
        a[r]![j] = a[r]![j]! - factor * row[j]!;
        inv[r]![j] = inv[r]![j]! - factor * irow[j]!;
      }
    }
  }
  return inv;
}
