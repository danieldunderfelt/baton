import { describe, expect, test } from "bun:test";

import {
  addGradeEvent,
  blend,
  decayAccumulator,
  decayFactor,
  halfLifeMs,
  laterOf,
  mean,
  nEff,
  removeGradeEvent,
  weightAt,
} from "./decay.ts";
import type { Accumulator } from "./types.ts";

const DAY = 24 * 60 * 60 * 1000;
const HL = halfLifeMs(90);
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
/** Days after T0. */
const at = (days: number) => iso(T0 + days * DAY);

function empty(asOf = at(0)): Accumulator {
  return {
    target: "kimi:default/kimi-code/k3@a1+full",
    model: "kimi-k3",
    category: "",
    sumWg: 0,
    sumW: 0,
    sumW2: 0,
    n: 0,
    asOf,
  };
}

/** Relative closeness — nEff runs an order of magnitude above the means. */
function expectClose(actual: number, expected: number, tol = 1e-9): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(expected)));
}

describe("halfLifeMs / weightAt", () => {
  test("half-life converts days to milliseconds", () => {
    expect(halfLifeMs(90)).toBe(90 * DAY);
    expect(halfLifeMs(1)).toBe(DAY);
  });

  test("weight halves once per half-life", () => {
    expect(weightAt(0, HL)).toBe(1);
    expect(weightAt(HL, HL)).toBeCloseTo(0.5, 12);
    expect(weightAt(2 * HL, HL)).toBeCloseTo(0.25, 12);
    expect(weightAt(10 * HL, HL)).toBeCloseTo(2 ** -10, 12);
  });

  test("evidence is never amplified: negative or unparseable ages weigh 1", () => {
    expect(weightAt(-5 * DAY, HL)).toBe(1);
    expect(weightAt(NaN, HL)).toBe(1);
    expect(decayFactor(at(10), at(3), HL)).toBe(1);
  });

  test("decayFactor is the weight of the elapsed span", () => {
    expect(decayFactor(at(0), at(90), HL)).toBeCloseTo(0.5, 12);
  });
});

describe("decayAccumulator", () => {
  const seeded = (): Accumulator => ({ ...empty(), sumWg: 12, sumW: 4, sumW2: 4, n: 4 });

  test("sums decay by the factor and Σw² by its square", () => {
    const decayed = decayAccumulator(seeded(), at(90), HL);
    expect(decayed.sumWg).toBeCloseTo(6, 12);
    expect(decayed.sumW).toBeCloseTo(2, 12);
    expect(decayed.sumW2).toBeCloseTo(1, 12);
    expect(decayed.asOf).toBe(at(90));
  });

  test("the mean is invariant under decay, nEff is not", () => {
    const before = seeded();
    const after = decayAccumulator(before, at(180), HL);
    expectClose(mean(after)!, mean(before)!);
    // Σw² falling twice as fast keeps nEff = (Σw)²/Σw² unchanged: decay alone
    // is not evidence loss in the sample-size sense, ageing all of it equally.
    expectClose(nEff(after), nEff(before));
  });

  test("the raw count does not decay", () => {
    expect(decayAccumulator(seeded(), at(3650), HL).n).toBe(4);
  });

  test("as_of never rewinds — decaying to an earlier time is a no-op", () => {
    const acc = { ...seeded(), asOf: at(30) };
    const back = decayAccumulator(acc, at(10), HL);
    expect(back).toEqual(acc);
  });
});

describe("addGradeEvent / removeGradeEvent", () => {
  test("a fresh grade on a fresh run weighs 1", () => {
    const acc = addGradeEvent(empty(), 4, at(0), at(0), HL);
    expect(acc).toMatchObject({ sumWg: 4, sumW: 1, sumW2: 1, n: 1, asOf: at(0) });
    expect(mean(acc)).toBe(4);
    expect(nEff(acc)).toBe(1);
  });

  test("a late grade weighs from the run's time, not the grading time", () => {
    const late = addGradeEvent(empty(), 4, at(0), at(90), HL);
    expect(late.sumW).toBeCloseTo(0.5, 12);
    expect(late.sumWg).toBeCloseTo(2, 12);
    expect(late.sumW2).toBeCloseTo(0.25, 12);
    // Half the weight, but still one observation and the same mean.
    expect(late.n).toBe(1);
    expect(mean(late)).toBeCloseTo(4, 12);
  });

  test("the accumulator is decayed forward before the event lands", () => {
    const old = addGradeEvent(empty(), 2, at(0), at(0), HL);
    const acc = addGradeEvent(old, 4, at(90), at(90), HL);
    // Old event decayed to 0.5, new one at full weight: (2*0.5 + 4)/1.5.
    expectClose(acc.sumW, 1.5);
    expectClose(mean(acc)!, (2 * 0.5 + 4) / 1.5);
    expectClose(nEff(acc), 1.5 ** 2 / (0.25 + 1));
  });

  test("removing an event exactly cancels its earlier contribution", () => {
    const withBoth = addGradeEvent(addGradeEvent(empty(), 5, at(1), at(2), HL), 2, at(3), at(4), HL);
    const removed = removeGradeEvent(withBoth, 5, at(1), at(10), HL);
    const onlyB = decayAccumulator(addGradeEvent(empty(), 2, at(3), at(4), HL), at(10), HL);

    expectClose(removed.sumWg, onlyB.sumWg, 1e-12);
    expectClose(removed.sumW, onlyB.sumW, 1e-12);
    expectClose(removed.sumW2, onlyB.sumW2, 1e-12);
    expect(removed.n).toBe(1);
  });

  test("sums never go negative when more is removed than was ever added", () => {
    const acc = removeGradeEvent(empty(), 5, at(0), at(0), HL);
    expect(acc).toMatchObject({ sumWg: 0, sumW: 0, sumW2: 0, n: 0 });
  });
});

describe("mean / nEff", () => {
  test("no evidence means no answer, not zero", () => {
    expect(mean(empty())).toBeNull();
    expect(nEff(empty())).toBe(0);
  });

  test("nEff equals the count when weights are equal, and drops when they are not", () => {
    let equal = empty();
    for (let i = 0; i < 5; i++) equal = { ...addGradeEvent(equal, 3, at(0), at(0), HL), asOf: at(0) };
    expectClose(nEff(equal), 5);

    // One fresh observation plus one nearly worn out is worth less than two.
    const skewed = addGradeEvent(addGradeEvent(empty(), 3, at(-900), at(0), HL), 3, at(0), at(0), HL);
    expect(nEff(skewed)).toBeLessThan(2);
    expect(nEff(skewed)).toBeGreaterThan(1);
  });

  test("residual floating-point dust is not evidence", () => {
    expect(mean({ ...empty(), sumW: 1e-15, sumWg: 4e-15 })).toBeNull();
  });
});

describe("blend", () => {
  test("shrinks the observation toward the prior by relative weight", () => {
    expect(blend(5, 1, 3, 1)).toBe(4);
    expect(blend(5, 3, 3, 1)).toBe(4.5);
    expect(blend(5, 0.001, 3, 5)).toBeCloseTo(3.0004, 4);
  });

  test("a missing side leaves the other untouched", () => {
    expect(blend(null, 0, 3.5, 5)).toBe(3.5);
    expect(blend(4.2, 6, null, 0)).toBe(4.2);
    expect(blend(null, 0, null, 0)).toBeNull();
  });

  test("a side with no weight has no say — zero total weight is unrated", () => {
    // A muted prior (profile weight 0) or one decayed to nothing must not route
    // as if it were rated, and neither must a mean whose weight is gone.
    expect(blend(null, 0, 3, 0)).toBeNull();
    expect(blend(4, 0, 3, 0)).toBeNull();
    expect(blend(4, 0, null, 0)).toBeNull();
  });
});

describe("laterOf", () => {
  test("an aggregate's clock never rewinds", () => {
    expect(laterOf(at(10), at(3))).toBe(at(10));
    expect(laterOf(at(3), at(10))).toBe(at(10));
    expect(laterOf(at(5), at(5))).toBe(at(5));
  });
});

/**
 * The load-bearing property: write-side decay-forward over mixed-age evidence
 * must be indistinguishable from weighting every event directly at read time.
 * Seeded, out-of-order run times, late grades — if the incremental rule is
 * wrong anywhere, this diverges.
 */
describe("decay-forward equals brute force (property)", () => {
  /** mulberry32 — seeded, so a failure is reproducible. */
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  interface Event {
    grade: number;
    runAt: number;
    gradedAt: number;
  }

  function events(seed: number, count: number): Event[] {
    const rand = rng(seed);
    const list: Event[] = [];
    for (let i = 0; i < count; i++) {
      // Runs scattered over ~400 days, graded anywhere from minutes to 200
      // days later, so the gradedAt order shuffles the runAt order hard.
      const runAt = T0 + Math.floor(rand() * 400 * DAY);
      const gradedAt = runAt + Math.floor(rand() * 200 * DAY);
      list.push({ grade: 1 + Math.floor(rand() * 5), runAt, gradedAt });
    }
    return list.sort((a, b) => a.gradedAt - b.gradedAt);
  }

  for (const seed of [1, 7, 42, 1337, 20260824]) {
    for (const halfLifeDays of [90, 7]) {
      test(`seed ${seed}, half-life ${halfLifeDays}d, 200 mixed-age events`, () => {
        const hl = halfLifeMs(halfLifeDays);
        const list = events(seed, 200);
        const readAt = list[list.length - 1]!.gradedAt + 33 * DAY;

        let acc = empty(iso(list[0]!.runAt));
        for (const e of list) acc = addGradeEvent(acc, e.grade, iso(e.runAt), iso(e.gradedAt), hl);
        const read = decayAccumulator(acc, iso(readAt), hl);

        let sumWg = 0;
        let sumW = 0;
        let sumW2 = 0;
        for (const e of list) {
          const w = 2 ** (-(readAt - e.runAt) / hl);
          sumWg += w * e.grade;
          sumW += w;
          sumW2 += w * w;
        }

        expectClose(mean(read)!, sumWg / sumW);
        expectClose(nEff(read), (sumW * sumW) / sumW2);
        expect(read.n).toBe(200);
      });
    }
  }

  test("a replaced grade leaves exactly the state of never having been added", () => {
    const hl = halfLifeMs(90);
    const list = events(99, 60);
    const readAt = list[list.length - 1]!.gradedAt + 10 * DAY;
    const victim = list[17]!;

    let withVictim = empty(iso(list[0]!.runAt));
    let without = empty(iso(list[0]!.runAt));
    for (const e of list) {
      withVictim = addGradeEvent(withVictim, e.grade, iso(e.runAt), iso(e.gradedAt), hl);
      if (e !== victim) without = addGradeEvent(without, e.grade, iso(e.runAt), iso(e.gradedAt), hl);
    }
    const corrected = decayAccumulator(
      removeGradeEvent(withVictim, victim.grade, iso(victim.runAt), iso(readAt), hl),
      iso(readAt),
      hl,
    );
    const reference = decayAccumulator(without, iso(readAt), hl);

    expectClose(corrected.sumWg, reference.sumWg, 1e-12);
    expectClose(corrected.sumW, reference.sumW, 1e-12);
    expectClose(corrected.sumW2, reference.sumW2, 1e-12);
    expectClose(nEff(corrected), nEff(reference), 1e-9);
    expect(corrected.n).toBe(reference.n);
  });
});
