/**
 * Blind A/B duels and the Bradley-Terry layer (PLAN.md §Evaluation).
 * Duels run both sides with identical options and cwd; labels are randomized
 * and the mapping is revealed only after judgment. BT ratings are reported as
 * a SEPARATE signal from grade EMAs — never merged into `blended`.
 */

export interface DuelView {
  duelId: string;
  category: string;
  /** Blind labels only until reported; models revealed after. */
  runs: { label: "A" | "B"; runId: string }[];
  status: "running" | "awaiting_judgment" | "reported" | "failed";
  /** Present once reported. */
  winner?: "A" | "B" | "tie";
  revealed?: { A: string; B: string };
  createdAt: string;
}

/**
 * One decayed pairwise edge. Stored with model_a < model_b lexicographically;
 * wins decay with the same half-life as grades (write-side decay-forward,
 * per-edge as_of).
 *
 * Exactly one unit of comparison mass per judged duel: a decisive verdict is a
 * whole win on one side, a tie is a whole `ties`. The fitter is what splits a
 * tie TIE_WEIGHT each way — storing the split as well would make one tie count
 * for two comparisons.
 */
export interface BtEdge {
  modelA: string;
  modelB: string;
  category: string;
  winsA: number;
  winsB: number;
  ties: number;
  /** Σw² over the events behind this edge (decayed by the square) — for nEff. */
  mass2: number;
  asOf: string;
}

/** A resolved prior for one (model, category): mean plus its pseudo-edge weight. */
export interface BtPrior {
  /** On the grade scale (1–5). */
  mean: number;
  /** Effective pseudo-edge mass — see `btRatings` for how it is resolved. */
  weight: number;
}

export interface BtRating {
  model: string;
  category: string;
  /**
   * Log-strength from the regularized fit. Anchored, never recentered:
   * 0 is the fixed neutral opponent (grade 3), so a prior-only model sits
   * exactly on its prior and other models' duels cannot move it.
   */
  theta: number;
  /** Marginal posterior sd of the anchored theta (full-covariance diagonal). */
  se: number;
  /** Effective number of comparisons behind it: (Σw)²/Σw² over its edges. */
  nEff: number;
  /** False when the MM fit hit maxIter — thetas/ses are then approximate. */
  converged: boolean;
}

/**
 * Regularization: every model gets a shrinkage pseudo-edge toward its
 * canonical prior mean (mapped from the 1–5 grade scale onto log-strength),
 * so sparse duel graphs stay identified and seeded opinions act as the
 * hierarchical prior — evidence corrects them, never the reverse.
 */
export const BT_SHRINKAGE_WEIGHT = 2;
/** Ties count as half a win each way. */
export const TIE_WEIGHT = 0.5;
