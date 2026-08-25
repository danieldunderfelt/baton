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
 */
export interface BtEdge {
  modelA: string;
  modelB: string;
  category: string;
  winsA: number;
  winsB: number;
  ties: number;
  asOf: string;
}

export interface BtRating {
  model: string;
  category: string;
  /** Log-strength from the regularized fit, anchored for identifiability. */
  theta: number;
  /** Approximate posterior sd of theta. */
  se: number;
  /** Decayed comparison mass this model participated in. */
  nEff: number;
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
