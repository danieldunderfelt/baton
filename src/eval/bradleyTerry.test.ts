import { describe, expect, test } from "bun:test";
import { fitBradleyTerry } from "./bradleyTerry.ts";
import type { BtEdge } from "./duelTypes.ts";

/**
 * The fit is pure math over already-decayed counts: `asOf` is never read here,
 * so a fixed timestamp suffices for every edge.
 */
const AS_OF = "2026-08-25T00:00:00.000Z";

function edge(
  modelA: string,
  modelB: string,
  category: string,
  winsA: number,
  winsB: number,
  ties = 0,
): BtEdge {
  return { modelA, modelB, category, winsA, winsB, ties, asOf: AS_OF };
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
        ["model-p", 2.0],
        ["model-q", 4.5],
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

  test("centering invariant: nEff-weighted mean of thetas is 0 per category", () => {
    const ratings = fitBradleyTerry(
      [
        edge("model-a", "model-b", "implementation", 6, 2),
        edge("model-b", "model-c", "implementation", 5, 5, 2),
      ],
      new Map([["model-c", 4.0]]),
    );
    const cat = ratings.filter((r) => r.category === "implementation");
    expect(cat.length).toBeGreaterThanOrEqual(3);
    const wSum = cat.reduce((s, r) => s + r.nEff, 0);
    expect(wSum).toBeGreaterThan(0);
    const wMean = cat.reduce((s, r) => s + r.nEff * r.theta, 0) / wSum;
    expect(Math.abs(wMean)).toBeLessThan(1e-6);
  });

  test("determinism: identical fresh inputs give bit-identical output", () => {
    const build = () => ({
      edges: [
        edge("model-a", "model-b", "implementation", 8, 2),
        edge("model-b", "model-c", "implementation", 4, 4, 3),
        edge("model-a", "model-c", "research", 2, 6),
      ],
      priors: new Map([
        ["model-c", 4.0],
        ["model-d", 2.5],
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
      new Map([["model-c", 3.5]]),
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
