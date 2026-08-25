import { BT_SHRINKAGE_WEIGHT, TIE_WEIGHT } from "./duelTypes.ts";
import type { BtEdge, BtRating } from "./duelTypes.ts";

/**
 * Regularized Bradley-Terry over log-strengths (PLAN.md §Evaluation: "shrinkage
 * to the canonical prior, identifiability anchored"). Every model gets a
 * shrinkage pseudo-edge against a fixed virtual anchor (theta 0), so sparse or
 * disconnected duel graphs stay numerically identified instead of diverging:
 * duel evidence moves a model away from its prior, never the reverse.
 *
 * Pure math only — no clock, no store. `asOf` is ignored; decay is applied
 * upstream before edges reach this fit.
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

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** A prior mean on the 1–5 grade scale mapped onto log-strength; 3 is neutral. */
function priorToTheta(priorMean: number): number {
  return (priorMean - 3) * 0.5;
}

/** One comparison a model is party to: real duel edge or the shrinkage pseudo-edge. */
interface Comparison {
  /** Total mass of the comparison (winsA + winsB + ties, or shrinkage weight). */
  weight: number;
  /** Opponent strength index, or -1 for the fixed anchor (strength 1). */
  opponent: number;
}

/**
 * Fits one rating per (model, category): categories are independent subgraphs,
 * so a model can be strong in one and weak in another. Models with no real
 * comparison mass and no prior are excluded — nobody has an opinion about them.
 *
 * Deterministic by construction: models are sorted before any summation, so
 * floating-point accumulation order is stable across identical calls.
 */
export function fitBradleyTerry(
  edges: BtEdge[],
  priors: Map<string, number>,
  opts?: FitOptions,
): BtRating[] {
  const shrinkageWeight = opts?.shrinkageWeight ?? BT_SHRINKAGE_WEIGHT;
  const maxIter = opts?.maxIter ?? 500;
  const tol = opts?.tol ?? 1e-9;

  const categories = [...new Set(edges.map((e) => e.category))].sort();
  const priorModels = [...priors.keys()].sort();

  const ratings: BtRating[] = [];
  for (const category of categories) {
    ratings.push(...fitCategory(category, edges, priors, priorModels, shrinkageWeight, maxIter, tol));
  }
  return ratings;
}

function fitCategory(
  category: string,
  edges: BtEdge[],
  priors: Map<string, number>,
  priorModels: string[],
  shrinkageWeight: number,
  maxIter: number,
  tol: number,
): BtRating[] {
  const catEdges = edges.filter((e) => e.category === category);

  // Real comparison mass per model, on either side of an edge.
  const mass = new Map<string, number>();
  for (const e of catEdges) {
    const w = e.winsA + e.winsB + e.ties;
    if (w > 0) {
      mass.set(e.modelA, (mass.get(e.modelA) ?? 0) + w);
      mass.set(e.modelB, (mass.get(e.modelB) ?? 0) + w);
    }
  }

  // Models with real mass or a prior; zero-mass prior-less models get no rating.
  const modelSet = new Set<string>([...mass.keys(), ...priorModels]);
  const models = [...modelSet].sort();
  if (models.length === 0) return [];
  const index = new Map(models.map((m, i) => [m, i]));

  // Wins-equivalents and comparison lists per model. Ties count TIE_WEIGHT each
  // way — directionless mass that still informs the shared scale.
  const wins = models.map(() => 0);
  const comps: Comparison[][] = models.map(() => []);
  for (const e of catEdges) {
    const total = e.winsA + e.winsB + e.ties;
    const a = index.get(e.modelA);
    const b = index.get(e.modelB);
    if (a === undefined || b === undefined) continue;
    wins[a] = wins[a]! + e.winsA + TIE_WEIGHT * e.ties;
    wins[b] = wins[b]! + e.winsB + TIE_WEIGHT * e.ties;
    comps[a]!.push({ weight: total, opponent: b });
    comps[b]!.push({ weight: total, opponent: a });
  }

  // Shrinkage pseudo-edge against the fixed anchor: fractional win/loss that
  // pulls theta toward the prior with intensity ~ shrinkageWeight. Models
  // without a prior anchor to 0 — an un-opinionated target, so duel evidence
  // alone moves them.
  const priorTheta = models.map((m) => {
    const p = priors.get(m);
    return p === undefined ? 0 : priorToTheta(p);
  });
  for (let i = 0; i < models.length; i++) {
    wins[i] = wins[i]! + shrinkageWeight * sigmoid(priorTheta[i]!);
    comps[i]!.push({ weight: shrinkageWeight, opponent: -1 });
  }

  // MM iterations: simultaneous strength updates (the standard Bradley-Terry
  // MLE fixed point), with the anchor's strength pinned at exp(0) = 1.
  let strengths = models.map(() => 1);
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
    if (maxDelta < tol) break;
  }

  let thetas = strengths.map((s) => Math.log(Math.max(s, EPSILON)));

  // Identifiability: recenter to an nEff-weighted mean of 0. The fit itself is
  // already anchored by the fixed virtual node; this is a post-hoc adjustment
  // of output values for interpretability. Fall back to a plain mean when no
  // model in the category has real mass (0/0 otherwise).
  const nEffs = models.map((m) => mass.get(m) ?? 0);
  let wSum = 0;
  let wMean = 0;
  for (let i = 0; i < models.length; i++) {
    wSum += nEffs[i]!;
    wMean += nEffs[i]! * thetas[i]!;
  }
  const shift = wSum > 0 ? wMean / wSum : thetas.reduce((a, t) => a + t, 0) / thetas.length;
  thetas = thetas.map((t) => t - shift);

  // Posterior sd from Fisher information at the converged strengths.
  return models.map((m, i) => {
    const s = strengths[i]!;
    let info = 0;
    for (const c of comps[i]!) {
      const sOpp = c.opponent < 0 ? 1 : strengths[c.opponent]!;
      const sum = s + sOpp;
      info += (c.weight * s * sOpp) / (sum * sum);
    }
    const se = info > 0 && Number.isFinite(info) ? 1 / Math.sqrt(info) : FALLBACK_SE;
    return { model: m, category, theta: thetas[i]!, se, nEff: nEffs[i]! };
  });
}
