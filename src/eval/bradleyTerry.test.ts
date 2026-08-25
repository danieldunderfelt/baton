import { describe, expect, test } from "bun:test";
import { fitBradleyTerry } from "./bradleyTerry.ts";
import { BT_SHRINKAGE_WEIGHT, type BtEdge, type BtPrior } from "./duelTypes.ts";

/**
 * The fit is pure math over already-decayed counts: `asOf` is never read here,
 * so a fixed timestamp suffices for every edge.
 */
const AS_OF = "2026-08-25T00:00:00.000Z";

/** Unit-weight events by default: n observations of weight 1 give Σw² = Σw. */
function edge(
  modelA: string,
  modelB: string,
  category: string,
  winsA: number,
  winsB: number,
  ties = 0,
  mass2 = winsA + winsB + ties,
): BtEdge {
  return { modelA, modelB, category, winsA, winsB, ties, mass2, asOf: AS_OF };
}

/** A prior at the full shrinkage budget unless the test is about a faded one. */
function prior(mean: number, weight = BT_SHRINKAGE_WEIGHT): BtPrior {
  return { mean, weight };
}

function ratingOf(
  ratings: ReturnType<typeof fitBradleyTerry>,
  model: string,
  category: string,
): { theta: number; se: number; nEff: number } {
  const r = ratings.find((x) => x.model === model && x.category === category);
  if (!r) throw new Error(`no rating for ${model}/${category}`);
  return r;
}

function thetaOf(ratings: ReturnType<typeof fitBradleyTerry>, model: string, category: string): number {
  const r = ratings.find((x) => x.model === model && x.category === category);
  if (!r) throw new Error(`no rating for ${model}/${category}`);
  return r.theta;
}

describe("fitBradleyTerry", () => {
  test("head-to-head: winner rates higher, implied win prob near the raw fraction", () => {
    const ratings = fitBradleyTerry(
      [edge("model-a", "model-b", "implementation", 8, 2)],
      new Map(),
    );
    const thetaA = thetaOf(ratings, "model-a", "implementation");
    const thetaB = thetaOf(ratings, "model-b", "implementation");
    expect(thetaA).toBeGreaterThan(thetaB);
    // Shrinkage pulls the raw 0.8 MLE toward 0.5; allow generous slack.
    const p = 1 / (1 + Math.exp(-(thetaA - thetaB)));
    expect(Math.abs(p - 0.8)).toBeLessThan(0.15);
  });

  test("transitivity propagates through a shared node without a direct edge", () => {
    const ratings = fitBradleyTerry(
      [
        edge("model-x", "model-y", "implementation", 9, 1),
        edge("model-y", "model-z", "implementation", 9, 1),
      ],
      new Map(),
    );
    const x = thetaOf(ratings, "model-x", "implementation");
    const y = thetaOf(ratings, "model-y", "implementation");
    const z = thetaOf(ratings, "model-z", "implementation");
    expect(x).toBeGreaterThan(y);
    expect(y).toBeGreaterThan(z);
  });

  test("shrinkage: thin/absent duel evidence tracks the prior ordering", () => {
    const ratings = fitBradleyTerry(
      [edge("model-o", "model-p", "implementation", 1, 1)],
      new Map([
        ["model-p", prior(2.0)],
        ["model-q", prior(4.5)],
      ]),
    );
    // model-p has near-even noise and a low prior; model-q has no duels at all
    // but a high prior — the prior must win.
    expect(thetaOf(ratings, "model-q", "implementation")).toBeGreaterThan(
      thetaOf(ratings, "model-p", "implementation"),
    );
  });

  test("ties carry no directional signal: thetas stay near-symmetric", () => {
    const ratings = fitBradleyTerry(
      [edge("model-a", "model-b", "implementation", 0, 0, 5)],
      new Map(),
    );
    const delta = Math.abs(
      thetaOf(ratings, "model-a", "implementation") - thetaOf(ratings, "model-b", "implementation"),
    );
    expect(delta).toBeLessThan(0.05);
  });

  test("disconnected duel graph stays identified and finite", () => {
    const ratings = fitBradleyTerry(
      [
        edge("model-a", "model-b", "implementation", 7, 3),
        edge("model-c", "model-d", "implementation", 1, 9),
      ],
      new Map(),
    );
    expect(ratings).toHaveLength(4);
    for (const r of ratings) {
      expect(Number.isFinite(r.theta)).toBe(true);
      expect(Number.isFinite(r.se)).toBe(true);
      expect(Number.isFinite(r.nEff)).toBe(true);
    }
  });

  /**
   * The anchored parameterization's whole point (review finding): a model with
   * a prior and no duels sits EXACTLY on its prior-mapped theta ((mean−3)·0.5),
   * and other models duelling each other cannot move it. A post-fit recentering
   * broke both.
   */
  test("a prior-only model sits on its prior and is unmoved by others' duels", () => {
    const alone = fitBradleyTerry([], new Map([["model-c", prior(4.0)]]));
    // No edges → no categories → no rows; the store-side entry point supplies
    // the category list. Fit with an unrelated duel present instead:
    expect(alone).toHaveLength(0);

    const ratings = fitBradleyTerry(
      [edge("model-a", "model-b", "implementation", 10, 0)],
      new Map([["model-c", prior(4.0)]]),
    );
    expect(thetaOf(ratings, "model-c", "implementation")).toBeCloseTo(0.5, 9);

    const lopsided = fitBradleyTerry(
      [edge("model-a", "model-b", "implementation", 100, 0)],
      new Map([["model-c", prior(4.0)]]),
    );
    expect(thetaOf(lopsided, "model-c", "implementation")).toBeCloseTo(0.5, 9);
  });

  test("a normal fit reports converged and theta 0 means the neutral anchor", () => {
    const ratings = fitBradleyTerry(
      [edge("model-a", "model-b", "implementation", 5, 5)],
      new Map(),
    );
    for (const r of ratings) expect(r.converged).toBe(true);
    // Symmetric, priorless: both sit at the anchor.
    expect(thetaOf(ratings, "model-a", "implementation")).toBeCloseTo(0, 9);
    expect(thetaOf(ratings, "model-b", "implementation")).toBeCloseTo(0, 9);
  });

  test("determinism: identical fresh inputs give bit-identical output", () => {
    const build = () => ({
      edges: [
        edge("model-a", "model-b", "implementation", 8, 2),
        edge("model-b", "model-c", "implementation", 4, 4, 3),
        edge("model-a", "model-c", "research", 2, 6),
      ],
      priors: new Map([
        ["model-c", prior(4.0)],
        ["model-d", prior(2.5)],
      ]),
    });
    const first = build();
    const second = build();
    expect(fitBradleyTerry(first.edges, first.priors)).toEqual(
      fitBradleyTerry(second.edges, second.priors),
    );
  });

  test("categories fit independently: one rating per model per category", () => {
    const ratings = fitBradleyTerry(
      [
        edge("model-m", "model-n", "implementation", 9, 1),
        edge("model-m", "model-o", "research", 1, 9),
      ],
      new Map(),
    );
    const keys = ratings.map((r) => `${r.model}/${r.category}`).sort();
    expect(keys).toEqual([
      "model-m/implementation",
      "model-m/research",
      "model-n/implementation",
      "model-o/research",
    ]);
    // Strong in one category, weak in the other — the fits don't bleed.
    expect(thetaOf(ratings, "model-m", "implementation")).toBeGreaterThan(
      thetaOf(ratings, "model-m", "research"),
    );
  });

  test("zero-mass models without a prior are excluded; prior-only models included", () => {
    const ratings = fitBradleyTerry(
      [edge("model-a", "model-b", "implementation", 0, 0)],
      new Map([["model-c", prior(3.5)]]),
    );
    // a and b carry no comparison mass and have no prior: nobody has an opinion.
    expect(ratings.find((r) => r.model === "model-a")).toBeUndefined();
    expect(ratings.find((r) => r.model === "model-b")).toBeUndefined();
    // c has a prior alone: it rates at its prior's log-strength, undiluted.
    const c = ratings.find((r) => r.model === "model-c");
    expect(c).toBeDefined();
    expect(c!.nEff).toBe(0);
    expect(Number.isFinite(c!.theta)).toBe(true);
    expect(Number.isFinite(c!.se)).toBe(true);
  });
});

describe("fitBradleyTerry — prior pseudo-edge weight", () => {
  /**
   * The prior owns its resolved share of the anchor and the rest of the anchor
   * stays neutral, so a faded prior pulls proportionally less. Flattening every
   * prior onto one fixed weight is what made a year-old imported opinion push
   * exactly as hard as a fresh one.
   */
  test("a faded prior pulls less than a full-weight one", () => {
    const pull = (weight: number) =>
      thetaOf(
        fitBradleyTerry(
          [edge("model-a", "model-b", "implementation", 5, 5)],
          new Map([["model-a", prior(5, weight)]]),
        ),
        "model-a",
        "implementation",
      );
    const fresh = pull(BT_SHRINKAGE_WEIGHT);
    const stale = pull(BT_SHRINKAGE_WEIGHT * 0.1);
    const muted = pull(0);
    expect(fresh).toBeGreaterThan(stale);
    expect(stale).toBeGreaterThan(muted);
    // A prior with no weight left is not an opinion: even evidence is neutral.
    expect(Math.abs(muted)).toBeLessThan(1e-6);
  });

  test("a weightless prior alone is not an opinion and gets no rating", () => {
    const ratings = fitBradleyTerry(
      [edge("model-a", "model-b", "implementation", 3, 1)],
      new Map([["model-z", prior(5, 0)]]),
    );
    expect(ratings.find((r) => r.model === "model-z")).toBeUndefined();
  });
});

describe("fitBradleyTerry — nEff and se", () => {
  /**
   * Sol's repro: ten observations of weight 0.1 are ten comparisons worth
   * (Σw)²/Σw² = 1²/0.1 = 10, not the raw decayed mass of 1 the fit used to
   * report — which claimed a decayed decade of duels was a single duel.
   */
  test("nEff is the Kish effective sample size, not the raw decayed mass", () => {
    const ratings = fitBradleyTerry(
      [edge("model-a", "model-b", "implementation", 0.6, 0.4, 0, 10 * 0.1 ** 2)],
      new Map(),
    );
    expect(ratingOf(ratings, "model-a", "implementation").nEff).toBeCloseTo(10, 9);
    expect(ratingOf(ratings, "model-b", "implementation").nEff).toBeCloseTo(10, 9);
  });

  test("an edge with no retained Σw² reports no effective sample", () => {
    const ratings = fitBradleyTerry(
      [edge("model-a", "model-b", "implementation", 3, 1, 0, 0)],
      new Map(),
    );
    expect(ratingOf(ratings, "model-a", "implementation").nEff).toBe(0);
  });

  /**
   * Two models, k wins each way, no priors: strengths fit at 1, so the full
   * information matrix is [[k/2+w, −k/2], [−k/2, k/2+w]] with the neutral
   * anchor's w = pairInfo(2, 1, 1) = 0.5. The marginal variance of one anchored
   * theta is (k/2+0.5)/((k/2+0.5)² − (k/2)²) = (k+1)/(k+0.5): the DIFFERENCE
   * tightens with k, but each absolute level is held only by the weight-2
   * anchor, so the marginal saturates near 1 instead of shrinking — which is
   * the honest statement about a pair the anchor can barely pin down.
   */
  test("se matches the analytic anchored marginal of the symmetric two-model fit", () => {
    for (const k of [1, 5, 40]) {
      const ratings = fitBradleyTerry(
        [edge("model-a", "model-b", "implementation", k, k)],
        new Map(),
      );
      const expected = Math.sqrt((k + 1) / (k + 0.5));
      expect(ratingOf(ratings, "model-a", "implementation").se).toBeCloseTo(expected, 9);
      expect(ratingOf(ratings, "model-b", "implementation").se).toBeCloseTo(expected, 9);
    }
  });

  /**
   * The off-diagonals still matter under anchored marginals: a heavier anchor
   * (a strong prior) pins its model's absolute position harder, so that model's
   * marginal se is smaller than its opponent's. A diagonal-only reciprocal of
   * the information would get the ordering right but the magnitude wrong —
   * the full inverse accounts for the pair's negative correlation.
   */
  test("the better-anchored model has the smaller marginal se", () => {
    const ratings = fitBradleyTerry(
      [edge("model-a", "model-b", "implementation", 7, 3)],
      new Map([["model-a", { mean: 4.5, weight: 8 }]]),
    );
    const a = ratingOf(ratings, "model-a", "implementation");
    const b = ratingOf(ratings, "model-b", "implementation");
    expect(a.se).toBeLessThan(b.se);
    expect(a.se).toBeGreaterThan(0);
  });

  test("more comparisons make the se smaller", () => {
    const seAt = (k: number) =>
      ratingOf(
        fitBradleyTerry([edge("model-a", "model-b", "implementation", k, k)], new Map()),
        "model-a",
        "implementation",
      ).se;
    expect(seAt(50)).toBeLessThan(seAt(5));
  });
});
