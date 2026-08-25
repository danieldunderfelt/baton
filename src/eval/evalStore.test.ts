import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensurePaths, resolvePaths } from "../config/paths.ts";
import { newId, openStore } from "../store/store.ts";
import { halfLifeMs } from "./decay.ts";
import {
  DEFAULT_PRIOR_WEIGHT,
  activePriors,
  activeProfile,
  diffPriors,
  effectiveRatings,
  importPriors,
  profileWeight,
  recordGrade,
  recordReliability,
  reliabilityFor,
  revision,
  seedPriors,
  setActiveProfile,
  setRatingSetting,
  splitTarget,
  targetRatings,
} from "./evalStore.ts";
import {
  PRIOR_WEIGHT_CAP,
  SETTING_HALF_LIFE_DAYS,
  SETTING_PROFILE_WEIGHT,
  type EffectiveRating,
} from "./types.ts";

/** A throwaway BATON_CONFIG_DIR scope. Never touches real Baton state. */
function scopeStore(name: string): Database {
  const root = mkdtempSync(join(tmpdir(), `baton-${name}-`));
  return openStore(ensurePaths(resolvePaths({ BATON_CONFIG_DIR: root })).dbPath);
}

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (days: number) => new Date(T0 + days * DAY).toISOString();

const KIMI = "kimi:default/kimi-code/k3@a1+full";
const KIMI_ALT = "kimi:work/kimi-code/k3@a1+full";
const CODEX = "codex:default/gpt-5.6-sol@a1+full";

/** grades.run_id is a real FK, so evidence always hangs off a real run. */
function insertRun(db: Database, id = newId("run"), createdAt = at(0)): string {
  db.query(
    `INSERT INTO runs (id, model, app, slug, prompt, cwd, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, "kimi-k3", "kimi", "kimi-code/k3", "say hi", "/tmp", "succeeded", createdAt, createdAt);
  return id;
}

interface GradeOverrides {
  runId?: string;
  grade?: number;
  target?: string;
  model?: string;
  category?: string;
  runAt?: string;
  gradedAt?: string;
}

function grade(db: Database, o: GradeOverrides = {}): number {
  const runId = o.runId ?? insertRun(db);
  return recordGrade(db, {
    runId,
    grade: o.grade ?? 4,
    target: o.target ?? KIMI,
    model: o.model ?? "kimi-k3",
    ...(o.category === undefined ? {} : { category: o.category }),
    runAt: o.runAt ?? at(0),
    gradedAt: o.gradedAt ?? at(0),
  });
}

const ratingFor = (rows: EffectiveRating[], model: string, category = "") =>
  rows.find((r) => r.model === model && r.category === category);

/** A duel edge is decayed sums like the accumulator, without going through duels.ts. */
const insertEdge = (db: Database, category = "impl") =>
  db
    .query(
      `INSERT INTO bt_edges (model_a, model_b, category, wins_a, wins_b, ties, mass2, as_of)
       VALUES ('kimi-k3', 'opus-5', ?, 1, 0, 0, 1, ?)`,
    )
    .run(category, at(0));

const edgeRows = (db: Database) =>
  db.query<{ model_a: string; mass2: number }, []>("SELECT model_a, mass2 FROM bt_edges").all();

const accumulatorRows = (db: Database) =>
  db
    .query<{ target: string; category: string; sum_w: number; sum_wg: number }, []>(
      "SELECT target, category, sum_w, sum_wg FROM accumulator ORDER BY target, category",
    )
    .all();

describe("recordGrade", () => {
  test("folds a grade into the accumulator and shows up as observed evidence", () => {
    const db = scopeStore("grade");
    grade(db, { grade: 5 });

    const rating = ratingFor(effectiveRatings(db, at(0)), "kimi-k3")!;
    expect(rating.observed).toBeCloseTo(5, 12);
    expect(rating.nEff).toBeCloseTo(1, 12);
    expect(rating.prior).toBeNull();
    expect(rating.blended).toBeCloseTo(5, 12);
  });

  test("rejects grades outside 1–5 without touching the database", () => {
    const db = scopeStore("grade-range");
    const runId = insertRun(db);
    for (const bad of [0, 6, -1, Number.NaN]) {
      expect(() => grade(db, { runId, grade: bad })).toThrow(/between 1 and 5/);
    }
    expect(accumulatorRows(db)).toEqual([]);
    expect(revision(db)).toBe(0);
  });

  test("a late grade weighs from the run's time", () => {
    const db = scopeStore("grade-late");
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(SETTING_HALF_LIFE_DAYS, "10");
    grade(db, { grade: 4, runAt: at(0), gradedAt: at(10) });

    // One 10-day-old run at a 10-day half-life: half weight, one observation.
    const row = accumulatorRows(db)[0]!;
    expect(row.sum_w).toBeCloseTo(0.5, 12);
    expect(row.sum_wg).toBeCloseTo(2, 12);
    expect(ratingFor(effectiveRatings(db, at(10)), "kimi-k3")!.observed).toBeCloseTo(4, 12);
  });

  test("the configured half-life is used, not just the default", () => {
    const db = scopeStore("grade-halflife");
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(SETTING_HALF_LIFE_DAYS, "1");
    grade(db, { grade: 4, runAt: at(0), gradedAt: at(0) });
    grade(db, { grade: 2, runAt: at(2), gradedAt: at(2) });

    // At a 1-day half-life the first grade is worth a quarter by day 2.
    const rating = ratingFor(effectiveRatings(db, at(2)), "kimi-k3")!;
    expect(rating.observed).toBeCloseTo((4 * 0.25 + 2) / 1.25, 12);
    expect(halfLifeMs(1)).toBe(DAY);
  });
});

describe("recordGrade — re-grading", () => {
  test("re-grading replaces the grade instead of adding a second one", () => {
    const db = scopeStore("regrade");
    const runId = insertRun(db);
    grade(db, { runId, grade: 5 });
    grade(db, { runId, grade: 2 });

    const rating = ratingFor(effectiveRatings(db, at(0)), "kimi-k3")!;
    expect(rating.observed).toBeCloseTo(2, 12);
    expect(rating.nEff).toBeCloseTo(1, 12);
    expect(accumulatorRows(db)).toHaveLength(1);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM grades").get()!.n).toBe(1);
  });

  test("a correction weeks later still cancels exactly, alongside other evidence", () => {
    const db = scopeStore("regrade-late");
    const corrected = insertRun(db);
    grade(db, { runId: corrected, grade: 5, runAt: at(0), gradedAt: at(1) });
    grade(db, { grade: 3, runAt: at(2), gradedAt: at(2) });
    grade(db, { runId: corrected, grade: 1, runAt: at(0), gradedAt: at(40) });

    // Same state as if the run had been graded 1 from the start.
    const reference = scopeStore("regrade-late-ref");
    grade(reference, { grade: 1, runAt: at(0), gradedAt: at(1) });
    grade(reference, { grade: 3, runAt: at(2), gradedAt: at(2) });

    const actual = ratingFor(effectiveRatings(db, at(60)), "kimi-k3")!;
    const expected = ratingFor(effectiveRatings(reference, at(60)), "kimi-k3")!;
    expect(actual.observed!).toBeCloseTo(expected.observed!, 10);
    expect(actual.nEff).toBeCloseTo(expected.nEff, 10);
  });

  test("re-grading onto a different category moves the evidence, never copies it", () => {
    const db = scopeStore("regrade-category");
    const runId = insertRun(db);
    grade(db, { runId, grade: 5, category: "implementation" });
    grade(db, { runId, grade: 5, category: "review" });

    const rows = accumulatorRows(db);
    expect(rows.map((r) => [r.category, Number(r.sum_w.toFixed(9))])).toEqual([
      ["implementation", 0],
      ["review", 1],
    ]);
  });
});

describe("recordGrade — out-of-order events", () => {
  test("a replayed regrade lands at the accumulator's clock, not behind it", () => {
    const db = scopeStore("regrade-out-of-order");
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(SETTING_HALF_LIFE_DAYS, "10");
    const first = insertRun(db);
    grade(db, { runId: first, grade: 5, runAt: at(0), gradedAt: at(0) });
    grade(db, { grade: 3, runAt: at(20), gradedAt: at(20) });

    // A replay delivers the correction with its original day-10 timestamp,
    // after the accumulator has already moved on to day 20.
    grade(db, { runId: first, grade: 1, runAt: at(0), gradedAt: at(10) });

    // Run 1 is worth 2^-2 = 0.25 at day 20, run 2 the full 1:
    // (1×0.25 + 3×1) / 1.25 = 2.6. Subtracting at the stale day-10 weight of
    // 0.5 would remove more than was ever there and leave 1.8.
    const rating = ratingFor(effectiveRatings(db, at(20)), "kimi-k3")!;
    expect(rating.observed).toBeCloseTo(2.6, 10);
    expect(accumulatorRows(db)[0]!.sum_w).toBeCloseTo(1.25, 10);
  });

  test("a backdated grade is treated as arriving now rather than rewinding as_of", () => {
    const db = scopeStore("grade-backdated");
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(SETTING_HALF_LIFE_DAYS, "10");
    grade(db, { grade: 4, runAt: at(20), gradedAt: at(20) });
    grade(db, { grade: 2, runAt: at(0), gradedAt: at(5) });

    // The second grade weighs from its run (day 0 → 0.25 at day 20), and the
    // first keeps its full weight instead of being decayed twice.
    const rows = accumulatorRows(db);
    expect(rows[0]!.sum_w).toBeCloseTo(1.25, 10);
    expect(rows[0]!.sum_wg).toBeCloseTo(4.5, 10);
    expect(
      db.query<{ as_of: string }, []>("SELECT as_of FROM accumulator").get()!.as_of,
    ).toBe(at(20));
  });
});

describe("recordGrade — transaction atomicity", () => {
  test("a failed commit leaves no accumulator, no grade and no revision bump", () => {
    const db = scopeStore("atomic");
    grade(db, { grade: 4 });
    const before = revision(db);
    const accBefore = accumulatorRows(db);

    // The FK on grades.run_id fires after the accumulator has been written:
    // if the transaction were not atomic, the evidence would survive.
    expect(() =>
      recordGrade(db, {
        runId: "run_never_existed",
        grade: 1,
        target: KIMI,
        model: "kimi-k3",
        runAt: at(0),
        gradedAt: at(0),
      }),
    ).toThrow();

    expect(accumulatorRows(db)).toEqual(accBefore);
    expect(revision(db)).toBe(before);
    expect(db.query("SELECT run_id FROM grades WHERE run_id = ?").get("run_never_existed")).toBeNull();
  });

  test("the revision bumps exactly once per committed grade", () => {
    const db = scopeStore("revision");
    expect(revision(db)).toBe(0);
    expect(grade(db, { grade: 4 })).toBe(1);
    expect(grade(db, { grade: 3 })).toBe(2);
    expect(revision(db)).toBe(2);
  });
});

describe("categories and target rollup", () => {
  test("categories accumulate separately and rate separately", () => {
    const db = scopeStore("categories");
    grade(db, { grade: 5, category: "implementation" });
    grade(db, { grade: 2, category: "review" });

    const rows = effectiveRatings(db, at(0));
    expect(ratingFor(rows, "kimi-k3", "implementation")!.observed).toBeCloseTo(5, 12);
    expect(ratingFor(rows, "kimi-k3", "review")!.observed).toBeCloseTo(2, 12);
    expect(ratingFor(rows, "kimi-k3", "")).toBeUndefined();
  });

  test("a model's targets roll up into one observed rating", () => {
    const db = scopeStore("rollup");
    grade(db, { grade: 5, target: KIMI });
    grade(db, { grade: 3, target: KIMI_ALT });

    // Evidence stays split per target on disk; the rollup happens at read time.
    expect(accumulatorRows(db).map((r) => r.target)).toEqual([KIMI, KIMI_ALT]);
    const rating = ratingFor(effectiveRatings(db, at(0)), "kimi-k3")!;
    expect(rating.observed).toBeCloseTo(4, 12);
    expect(rating.nEff).toBeCloseTo(2, 12);
  });

  test("different models never merge", () => {
    const db = scopeStore("models");
    grade(db, { grade: 5, target: KIMI, model: "kimi-k3" });
    grade(db, { grade: 2, target: CODEX, model: "gpt-5.6-sol" });

    const rows = effectiveRatings(db, at(0));
    expect(rows.map((r) => r.model)).toEqual(["gpt-5.6-sol", "kimi-k3"]);
    expect(ratingFor(rows, "gpt-5.6-sol")!.observed).toBeCloseTo(2, 12);
  });
});

describe("seedPriors", () => {
  test("stores capped, provenance-tagged priors and activates the first profile", () => {
    const db = scopeStore("seed");
    expect(activeProfile(db)).toBeNull();
    const seeded = seedPriors(
      db,
      "daniel",
      [
        { model: "fable-5", mean: 4.8, weight: 50 },
        { model: "kimi-k3", category: "implementation", mean: 4.2 },
      ],
      at(0),
    );

    expect(seeded.revision).toBe(1);
    // The echo is the store's own answer: input order, defaults and cap applied.
    expect(seeded.entries).toEqual([
      { model: "fable-5", category: "", mean: 4.8, weight: PRIOR_WEIGHT_CAP },
      { model: "kimi-k3", category: "implementation", mean: 4.2, weight: DEFAULT_PRIOR_WEIGHT },
    ]);
    expect(activeProfile(db)).toBe("daniel");
    expect(activePriors(db)).toEqual([
      {
        profile: "daniel",
        model: "fable-5",
        category: "",
        mean: 4.8,
        weight: PRIOR_WEIGHT_CAP,
        source: "seeded",
        asOf: at(0),
      },
      {
        profile: "daniel",
        model: "kimi-k3",
        category: "implementation",
        mean: 4.2,
        weight: DEFAULT_PRIOR_WEIGHT,
        source: "seeded",
        asOf: at(0),
      },
    ]);
  });

  test("a wrong seed cannot outweigh the cap however it is expressed", () => {
    const db = scopeStore("seed-cap");
    seedPriors(db, "p", [{ model: "opus-5", mean: 5, weight: Number.MAX_SAFE_INTEGER }], at(0));
    expect(activePriors(db)[0]!.weight).toBe(PRIOR_WEIGHT_CAP);
  });

  test("rejects means off the grade scale and negative weights, writing nothing", () => {
    const db = scopeStore("seed-invalid");
    expect(() => seedPriors(db, "p", [{ model: "opus-5", mean: 9 }], at(0))).toThrow(
      /between 1 and 5/,
    );
    expect(() => seedPriors(db, "p", [{ model: "opus-5", mean: 4, weight: -1 }], at(0))).toThrow(
      /non-negative/,
    );
    expect(activeProfile(db)).toBeNull();
    expect(revision(db)).toBe(0);
  });

  test("re-seeding an active scope updates in place and does not steal the active profile", () => {
    const db = scopeStore("seed-again");
    seedPriors(db, "first", [{ model: "opus-5", mean: 4 }], at(0));
    seedPriors(db, "second", [{ model: "opus-5", mean: 2 }], at(1));
    expect(activeProfile(db)).toBe("first");

    seedPriors(db, "first", [{ model: "opus-5", mean: 3.5, weight: 2 }], at(2));
    expect(activePriors(db)).toMatchObject([{ mean: 3.5, weight: 2, asOf: at(2) }]);
    expect(revision(db)).toBe(3);
  });
});

describe("importPriors", () => {
  const entries = [
    { model: "opus-5", mean: 4 },
    { model: "fable-5", mean: 5, weight: 3 },
  ];

  test("tags provenance, never auto-activates, and reports every row as added", () => {
    const db = scopeStore("import");
    const diff = importPriors(db, "shared", entries, "teammate", at(0));

    expect(activeProfile(db)).toBeNull();
    expect(diff.source).toBe("teammate");
    expect(diff.added).toEqual([
      { model: "opus-5", category: "", mean: 4, weight: DEFAULT_PRIOR_WEIGHT },
      { model: "fable-5", category: "", mean: 5, weight: 3 },
    ]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toEqual([]);
    expect(diff.revision).toBe(1);
    setActiveProfile(db, "shared");
    expect(activePriors(db)[0]!.source).toBe("imported:teammate");
  });

  test("a re-import diffs old against new instead of silently reweighting", () => {
    const db = scopeStore("import-diff");
    importPriors(db, "shared", entries, "teammate", at(0));
    const diff = importPriors(
      db,
      "shared",
      [
        { model: "opus-5", mean: 4 },
        { model: "fable-5", mean: 4.5, weight: 3 },
        { model: "grok-4.6", mean: 3 },
      ],
      "teammate-v2",
      at(10),
    );

    // opus-5's numbers are identical, but the write would restamp its as_of and
    // relabel its provenance — both reweight or re-attribute it, so neither is
    // "unchanged".
    expect(diff.unchanged).toEqual([]);
    expect(diff.added.map((r) => r.model)).toEqual(["grok-4.6"]);
    expect(diff.changed).toEqual([
      {
        model: "opus-5",
        category: "",
        mean: 4,
        weight: DEFAULT_PRIOR_WEIGHT,
        previous: {
          mean: 4,
          weight: DEFAULT_PRIOR_WEIGHT,
          source: "imported:teammate",
          asOf: at(0),
        },
      },
      {
        model: "fable-5",
        category: "",
        mean: 4.5,
        weight: 3,
        previous: { mean: 5, weight: 3, source: "imported:teammate", asOf: at(0) },
      },
    ]);
  });

  test("a re-import that only refreshes as_of is a change, not a no-op", () => {
    const db = scopeStore("import-as-of");
    const stale = [{ model: "opus-5", mean: 4, weight: 8, asOf: at(-400) }];
    importPriors(db, "shared", stale, "teammate", at(0));

    // Byte-identical numbers, a fresher as_of: silently restoring eight
    // pseudo-observations of precision is exactly what the diff must not hide.
    const refreshed = importPriors(
      db,
      "shared",
      [{ model: "opus-5", mean: 4, weight: 8, asOf: at(0) }],
      "teammate",
      at(1),
    );
    expect(refreshed.unchanged).toEqual([]);
    expect(refreshed.changed).toEqual([
      {
        model: "opus-5",
        category: "",
        mean: 4,
        weight: 8,
        previous: { mean: 4, weight: 8, source: "imported:teammate", asOf: at(-400) },
      },
    ]);

    // Re-importing the very same document really is a no-op.
    expect(importPriors(db, "shared", [{ ...stale[0]!, asOf: at(0) }], "teammate", at(2)).unchanged)
      .toHaveLength(1);
  });

  test("a re-import under a different source is a change even with identical numbers", () => {
    const db = scopeStore("import-source");
    const entry = [{ model: "opus-5", mean: 4, asOf: at(0) }];
    importPriors(db, "shared", entry, "alice", at(0));
    const diff = importPriors(db, "shared", entry, "bob", at(1));

    expect(diff.unchanged).toEqual([]);
    expect(diff.changed[0]!.previous.source).toBe("imported:alice");
  });

  test("imported weights are capped like seeded ones", () => {
    const db = scopeStore("import-cap");
    importPriors(db, "shared", [{ model: "opus-5", mean: 4, weight: 999 }], "teammate", at(0));
    setActiveProfile(db, "shared");
    expect(activePriors(db)[0]!.weight).toBe(PRIOR_WEIGHT_CAP);
  });
});

describe("effectiveRatings", () => {
  test("blends observed evidence with the active prior by weight", () => {
    const db = scopeStore("blend");
    seedPriors(db, "daniel", [{ model: "kimi-k3", mean: 3, weight: 3 }], at(0));
    grade(db, { grade: 5 });

    const rating = ratingFor(effectiveRatings(db, at(0)), "kimi-k3")!;
    expect(rating.observed).toBeCloseTo(5, 12);
    expect(rating.prior).toBe(3);
    expect(rating.priorWeight).toBe(3);
    expect(rating.blended).toBeCloseTo((5 * 1 + 3 * 3) / 4, 12);
  });

  test("the profile weight scales the prior at read time, leaving the stored cap alone", () => {
    const db = scopeStore("profile-weight");
    seedPriors(db, "daniel", [{ model: "kimi-k3", mean: 3, weight: 4 }], at(0));
    grade(db, { grade: 5 });
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(SETTING_PROFILE_WEIGHT, "0.5");

    const rating = ratingFor(effectiveRatings(db, at(0)), "kimi-k3")!;
    expect(rating.priorWeight).toBe(2);
    expect(rating.blended).toBeCloseTo((5 * 1 + 3 * 2) / 3, 12);
    expect(activePriors(db)[0]!.weight).toBe(4);

    // Weight 0 mutes the prior entirely without deleting it.
    db.query("UPDATE settings SET value = ? WHERE key = ?").run("0", SETTING_PROFILE_WEIGHT);
    const muted = ratingFor(effectiveRatings(db, at(0)), "kimi-k3")!;
    expect(muted.priorWeight).toBe(0);
    expect(muted.blended).toBeCloseTo(5, 12);
    expect(muted.prior).toBe(3);
  });

  test("prior-only, observed-only and blended models all surface, deterministically ordered", () => {
    const db = scopeStore("mixed");
    seedPriors(
      db,
      "daniel",
      [
        { model: "opus-5", mean: 4.5, weight: 2 },
        { model: "kimi-k3", mean: 3, weight: 2 },
      ],
      at(0),
    );
    grade(db, { grade: 5, target: KIMI, model: "kimi-k3" });
    grade(db, { grade: 2, target: CODEX, model: "gpt-5.6-sol" });

    const rows = effectiveRatings(db, at(0));
    expect(rows.map((r) => r.model)).toEqual(["gpt-5.6-sol", "kimi-k3", "opus-5"]);

    const priorOnly = ratingFor(rows, "opus-5")!;
    expect(priorOnly.observed).toBeNull();
    expect(priorOnly.nEff).toBe(0);
    expect(priorOnly.blended).toBe(4.5);

    const observedOnly = ratingFor(rows, "gpt-5.6-sol")!;
    expect(observedOnly.prior).toBeNull();
    expect(observedOnly.priorWeight).toBe(0);
    expect(observedOnly.blended).toBeCloseTo(2, 12);

    // A model nobody rated or ran is simply absent — "unrated", not a zero.
    expect(ratingFor(rows, "grok-4.6")).toBeUndefined();
  });

  test("switching profiles swaps the prior and leaves observed evidence intact", () => {
    const db = scopeStore("switch");
    seedPriors(db, "optimist", [{ model: "kimi-k3", mean: 5, weight: 2 }], at(0));
    importPriors(db, "pessimist", [{ model: "kimi-k3", mean: 2, weight: 2 }], "teammate", at(0));
    grade(db, { grade: 4 });

    expect(ratingFor(effectiveRatings(db, at(0)), "kimi-k3")!.prior).toBe(5);
    const rev = setActiveProfile(db, "pessimist");
    const after = ratingFor(effectiveRatings(db, at(0)), "kimi-k3")!;
    expect(after.prior).toBe(2);
    expect(after.observed).toBeCloseTo(4, 12);
    expect(rev).toBe(revision(db));
  });

  test("read-side decay ages evidence without writing to the accumulator", () => {
    const db = scopeStore("read-decay");
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(SETTING_HALF_LIFE_DAYS, "10");
    seedPriors(db, "daniel", [{ model: "kimi-k3", mean: 2, weight: 1 }], at(0));
    grade(db, { grade: 5, runAt: at(0), gradedAt: at(0) });

    const fresh = ratingFor(effectiveRatings(db, at(0)), "kimi-k3")!;
    const stale = ratingFor(effectiveRatings(db, at(30)), "kimi-k3")!;

    // The mean holds, but its say in the blend fades to Σw = 0.125.
    expect(stale.observed).toBeCloseTo(5, 12);
    expect(fresh.blended).toBeCloseTo(3.5, 12);
    // Prior and evidence are the same age here, so both fade to 0.125 and the
    // blend holds: ageing alone never shifts the balance between them.
    expect(stale.priorWeight).toBeCloseTo(0.125, 12);
    expect(stale.blended).toBeCloseTo(3.5, 12);
    expect(accumulatorRows(db)[0]!.sum_w).toBeCloseTo(1, 12);
  });

  test("the prior's precision decays from its own as_of, not forever", () => {
    const db = scopeStore("prior-decay");
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(SETTING_HALF_LIFE_DAYS, "10");
    // A stale imported opinion: weight 8 pseudo-observations, formed at day 0.
    importPriors(db, "alice", [{ model: "kimi-k3", mean: 1, weight: 8 }], "alice", at(0));
    setActiveProfile(db, "alice");
    grade(db, { grade: 5, runAt: at(0), gradedAt: at(0) });

    const stale = ratingFor(effectiveRatings(db, at(30)), "kimi-k3")!;
    // Three half-lives on: observed Σw and the prior's weight both fall to 1/8
    // of what they were — 0.125 and 8 × 0.125 = 1.
    expect(stale.priorWeight).toBeCloseTo(1, 12);
    expect(stale.blended).toBeCloseTo((5 * 0.125 + 1 * 1) / 1.125, 12);
    expect(stale.blended).toBeCloseTo(1.4444, 4);
    // Undecayed, the prior would still weigh 8 and drown the observation out.
    expect(stale.blended).not.toBeCloseTo((5 * 0.125 + 1 * 8) / 8.125, 4);
  });

  test("a prior older than the evidence loses to it instead of outranking it forever", () => {
    const db = scopeStore("prior-decay-old");
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(SETTING_HALF_LIFE_DAYS, "30");
    // An 18-month-old profile at the full cap, against one fresh graded run.
    importPriors(db, "alice", [{ model: "kimi-k3", mean: 1, weight: 10 }], "alice", at(-540));
    setActiveProfile(db, "alice");
    grade(db, { grade: 5, runAt: at(0), gradedAt: at(0) });

    const rating = ratingFor(effectiveRatings(db, at(0)), "kimi-k3")!;
    expect(rating.priorWeight).toBeLessThan(0.001);
    expect(rating.blended).toBeCloseTo(5, 3);
    // The opinion itself is still on the books — it is its precision that aged.
    expect(rating.prior).toBe(1);
  });

  test("a zero-weight prior does not route: no evidence means unrated, not the prior's mean", () => {
    const db = scopeStore("muted-prior");
    seedPriors(db, "daniel", [{ model: "opus-5", mean: 4.5, weight: 6 }], at(0));
    setRatingSetting(db, SETTING_PROFILE_WEIGHT, "0");

    const rating = ratingFor(effectiveRatings(db, at(0)), "opus-5")!;
    expect(rating.prior).toBe(4.5);
    expect(rating.priorWeight).toBe(0);
    expect(rating.observed).toBeNull();
    // Muting the profile mutes its say in routing; the model is simply unrated.
    expect(rating.blended).toBeNull();
  });
});

describe("reliability", () => {
  test("adapter outcomes accumulate against the target, not the model", () => {
    const db = scopeStore("reliability");
    recordReliability(db, KIMI, true, at(0));
    recordReliability(db, KIMI, true, at(0));
    recordReliability(db, KIMI, false, at(0));

    const rel = reliabilityFor(db, KIMI, at(0));
    expect(rel.sumWOk).toBeCloseTo(2, 12);
    expect(rel.sumWFail).toBeCloseTo(1, 12);
    expect(rel.rate).toBeCloseTo(2 / 3, 12);
    // Quality evidence is untouched by reliability events.
    expect(effectiveRatings(db, at(0))).toEqual([]);
  });

  test("older outcomes decay, so a recovered target stops looking broken", () => {
    const db = scopeStore("reliability-decay");
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(SETTING_HALF_LIFE_DAYS, "10");
    recordReliability(db, KIMI, false, at(0));
    recordReliability(db, KIMI, true, at(10));

    // The failure is worth 0.5 by day 10 against a fresh success.
    expect(reliabilityFor(db, KIMI, at(10)).rate).toBeCloseTo(1 / 1.5, 12);
    // Read-side ageing alone never shifts the ratio.
    expect(reliabilityFor(db, KIMI, at(100)).rate).toBeCloseTo(1 / 1.5, 12);
  });

  test("an out-of-order outcome does not rewind the row's as_of", () => {
    const db = scopeStore("reliability-out-of-order");
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(SETTING_HALF_LIFE_DAYS, "10");
    recordReliability(db, KIMI, false, at(0));
    recordReliability(db, KIMI, true, at(20));
    // A retried report arrives with its original, older timestamp.
    recordReliability(db, KIMI, true, at(10));

    const rel = reliabilityFor(db, KIMI, at(20));
    // Two successes at full weight against a day-0 failure worth 2^-2.
    expect(rel.sumWOk).toBeCloseTo(2, 10);
    expect(rel.sumWFail).toBeCloseTo(0.25, 10);
  });

  test("an unobserved target has no rate rather than a perfect one", () => {
    const db = scopeStore("reliability-empty");
    expect(reliabilityFor(db, CODEX, at(0))).toEqual({
      target: CODEX,
      sumWOk: 0,
      sumWFail: 0,
      rate: null,
    });
  });
});

describe("targetRatings", () => {
  test("keeps evidence per execution target, where the rollup averages it away", () => {
    const db = scopeStore("target-ratings");
    grade(db, { grade: 5, target: KIMI });
    grade(db, { grade: 1, target: KIMI_ALT });

    const rows = targetRatings(db, at(0));
    expect(rows.map((r) => [r.target, r.observed, r.weight, r.nEff])).toEqual([
      [KIMI, 5, 1, 1],
      [KIMI_ALT, 1, 1, 1],
    ]);
    // The canonical model is the rollup: it cannot tell the two instances apart.
    expect(ratingFor(effectiveRatings(db, at(0)), "kimi-k3")!.observed).toBeCloseTo(3, 12);
  });

  test("decays read-side to the read time without writing", () => {
    const db = scopeStore("target-ratings-decay");
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(SETTING_HALF_LIFE_DAYS, "10");
    grade(db, { grade: 4, target: KIMI, runAt: at(0), gradedAt: at(0) });

    const aged = targetRatings(db, at(20))[0]!;
    expect(aged.observed).toBeCloseTo(4, 12);
    expect(aged.weight).toBeCloseTo(0.25, 12);
    expect(accumulatorRows(db)[0]!.sum_w).toBeCloseTo(1, 12);
  });

  test("categories stay separate, so per-category evidence is addressable", () => {
    const db = scopeStore("target-ratings-category");
    grade(db, { grade: 5, target: KIMI, category: "review" });
    grade(db, { grade: 2, target: KIMI });

    expect(targetRatings(db, at(0)).map((r) => [r.category, r.observed])).toEqual([
      ["", 2],
      ["review", 5],
    ]);
  });

  test("splits each fingerprint into the route and the autonomy it ran at", () => {
    const db = scopeStore("target-ratings-autonomy");
    grade(db, { grade: 5, target: "kimi:default/kimi-code/k3@a1+v1.2.3+readonly" });
    expect(targetRatings(db, at(0))[0]).toMatchObject({
      route: "kimi:default/kimi-code/k3@a1+v1.2.3",
      autonomy: "readonly",
    });
  });
});

describe("splitTarget", () => {
  test("separates the autonomy segment from everything the registry minted", () => {
    expect(splitTarget("kimi:a/k3@a1+v1.2.3+full")).toEqual({
      route: "kimi:a/k3@a1+v1.2.3",
      autonomy: "full",
    });
    // Fingerprints written before the app version existed keep their old shape;
    // they age out by decay rather than being migrated.
    expect(splitTarget(KIMI)).toEqual({ route: "kimi:default/kimi-code/k3@a1", autonomy: "full" });
  });

  test("a tail that is not an authority level stays part of the route", () => {
    // Otherwise a version segment would be read as an autonomy level and the
    // lens would compare evidence against a level nothing ever ran at.
    expect(splitTarget("kimi:a/k3@a1+v1.2.3")).toEqual({
      route: "kimi:a/k3@a1+v1.2.3",
      autonomy: "",
    });
    expect(splitTarget("kimi:a/k3@a1")).toEqual({ route: "kimi:a/k3@a1", autonomy: "" });
  });
});

describe("diffPriors", () => {
  test("reports what a write would change, and writes nothing", () => {
    const db = scopeStore("diff-priors");
    seedPriors(db, "daniel", [{ model: "kimi-k3", mean: 3, weight: 2 }], at(0));

    const diff = diffPriors(db, "daniel", [
      { model: "kimi-k3", mean: 4, weight: 2 },
      { model: "opus-5", mean: 5 },
    ]);
    expect(diff.added).toEqual([
      { model: "opus-5", category: "", mean: 5, weight: DEFAULT_PRIOR_WEIGHT },
    ]);
    expect(diff.changed).toEqual([
      {
        model: "kimi-k3",
        category: "",
        mean: 4,
        weight: 2,
        previous: { mean: 3, weight: 2, source: "seeded", asOf: at(0) },
      },
    ]);
    expect(diff.unchanged).toEqual([]);
    // A dry run that mutated the store to describe itself would be no dry run.
    expect(activePriors(db)).toMatchObject([{ model: "kimi-k3", mean: 3 }]);
    expect(revision(db)).toBe(1);
  });

  test("is exactly the diff importPriors then reports, given the same source and time", () => {
    const db = scopeStore("diff-priors-agrees");
    seedPriors(db, "shared", [{ model: "kimi-k3", mean: 3 }], at(0));
    const entries = [
      { model: "kimi-k3", mean: 3 },
      { model: "opus-5", mean: 4 },
    ];
    // The write stamps provenance and a time, so a preview that does not know
    // them cannot claim to be the same diff — it is told what the write would do.
    const preview = diffPriors(db, "shared", entries, { source: "imported:alice", at: at(1) });
    const { profile: _p, source: _s, revision: _r, ...actual } = importPriors(
      db,
      "shared",
      entries,
      "alice",
      at(1),
    );
    expect(actual).toEqual(preview);
    expect(actual.changed.map((c) => c.model)).toEqual(["kimi-k3"]);
  });

  test("fields the caller has not resolved stay out of the comparison", () => {
    const db = scopeStore("diff-priors-partial");
    seedPriors(db, "daniel", [{ model: "kimi-k3", mean: 3, weight: 2 }], at(0));

    // No source and no write time given: a dry run that cannot know either must
    // not report every row as changed on their account.
    expect(diffPriors(db, "daniel", [{ model: "kimi-k3", mean: 3, weight: 2 }]).unchanged)
      .toHaveLength(1);
    // An entry carrying its own as_of is always compared on it.
    expect(
      diffPriors(db, "daniel", [{ model: "kimi-k3", mean: 3, weight: 2, asOf: at(5) }]).changed,
    ).toHaveLength(1);
  });
});

describe("prior as_of", () => {
  test("an entry's own as_of survives the write instead of being freshened", () => {
    const db = scopeStore("prior-as-of");
    importPriors(db, "alice", [{ model: "kimi-k3", mean: 4, asOf: at(-90) }], "alice", at(0));
    setActiveProfile(db, "alice");
    expect(activePriors(db)[0]!.asOf).toBe(at(-90));
  });
});

describe("setRatingSetting", () => {
  test("writes the setting and bumps the revision in one commit", () => {
    const db = scopeStore("rating-setting");
    const rev = setRatingSetting(db, SETTING_PROFILE_WEIGHT, "0.5");
    expect(rev).toBe(1);
    expect(revision(db)).toBe(1);
    expect(profileWeight(db)).toBe(0.5);
  });

  test("the bump is what lets a settings-only change reach the projection", () => {
    const db = scopeStore("rating-setting-projection");
    seedPriors(db, "daniel", [{ model: "kimi-k3", mean: 4, weight: 4 }], at(0));
    const before = ratingFor(effectiveRatings(db, at(0)), "kimi-k3")!;

    const rev = setRatingSetting(db, SETTING_PROFILE_WEIGHT, "0");
    const after = ratingFor(effectiveRatings(db, at(0)), "kimi-k3")!;
    expect(before.priorWeight).toBe(4);
    expect(after.priorWeight).toBe(0);
    expect(rev).toBeGreaterThan(1);
  });
});

describe("setRatingSetting — changing the half-life", () => {
  const halfLife = (db: Database) =>
    db
      .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?")
      .get(SETTING_HALF_LIFE_DAYS)?.value;

  test("is free while the scope holds no evidence", () => {
    const db = scopeStore("halflife-empty");
    seedPriors(db, "daniel", [{ model: "kimi-k3", mean: 4 }], at(0));
    expect(setRatingSetting(db, SETTING_HALF_LIFE_DAYS, "30")).toBe(2);
    expect(halfLife(db)).toBe("30");
  });

  test("is refused once the accumulator holds sums decayed at the old half-life", () => {
    const db = scopeStore("halflife-guard");
    setRatingSetting(db, SETTING_HALF_LIFE_DAYS, "10");
    grade(db, { grade: 5 });
    const before = revision(db);

    expect(() => setRatingSetting(db, SETTING_HALF_LIFE_DAYS, "90")).toThrow(/--reset-evidence/);
    // Nothing moved: not the setting, not the evidence, not the revision.
    expect(halfLife(db)).toBe("10");
    expect(accumulatorRows(db)).toHaveLength(1);
    expect(revision(db)).toBe(before);
  });

  test("is refused for reliability evidence too", () => {
    const db = scopeStore("halflife-guard-reliability");
    recordReliability(db, KIMI, true, at(0));
    expect(() => setRatingSetting(db, SETTING_HALF_LIFE_DAYS, "30")).toThrow(
      /observed evidence/,
    );
  });

  /**
   * Sol #1: the guard counted the accumulator and reliability only, so a scope
   * whose evidence was duels sailed through and every bt_edges sum — decayed
   * under the old curve — was silently reinterpreted under the new one.
   */
  test("is refused for duel-edge evidence too", () => {
    const db = scopeStore("halflife-guard-edges");
    setRatingSetting(db, SETTING_HALF_LIFE_DAYS, "10");
    insertEdge(db);
    const before = revision(db);

    expect(() => setRatingSetting(db, SETTING_HALF_LIFE_DAYS, "90")).toThrow(/--reset-evidence/);
    expect(halfLife(db)).toBe("10");
    expect(edgeRows(db)).toHaveLength(1);
    expect(revision(db)).toBe(before);
  });

  test("re-writing the same half-life is not a change and is always allowed", () => {
    const db = scopeStore("halflife-same");
    setRatingSetting(db, SETTING_HALF_LIFE_DAYS, "10");
    grade(db, { grade: 5 });
    expect(() => setRatingSetting(db, SETTING_HALF_LIFE_DAYS, "10")).not.toThrow();
    expect(accumulatorRows(db)).toHaveLength(1);
  });

  test("--reset-evidence wipes the aggregates in the same commit, keeping graded runs", () => {
    const db = scopeStore("halflife-reset");
    setRatingSetting(db, SETTING_HALF_LIFE_DAYS, "10");
    grade(db, { grade: 5 });
    recordReliability(db, KIMI, false, at(0));
    insertEdge(db);

    const rev = setRatingSetting(db, SETTING_HALF_LIFE_DAYS, "90", { resetEvidence: true });
    expect(halfLife(db)).toBe("90");
    expect(accumulatorRows(db)).toEqual([]);
    // The duel edge map holds decayed sums on the same curve, so it goes too.
    expect(edgeRows(db)).toEqual([]);
    expect(reliabilityFor(db, KIMI, at(0)).rate).toBeNull();
    expect(effectiveRatings(db, at(0))).toEqual([]);
    expect(rev).toBe(revision(db));
    // The grades ring is private history, not evidence, and survives.
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM grades").get()!.n).toBe(1);
  });

  test("priors are opinions, not decayed sums, and survive the reset", () => {
    const db = scopeStore("halflife-reset-priors");
    seedPriors(db, "daniel", [{ model: "opus-5", mean: 4.5, weight: 6 }], at(0));
    grade(db, { grade: 5 });

    setRatingSetting(db, SETTING_HALF_LIFE_DAYS, "30", { resetEvidence: true });
    expect(activePriors(db)).toMatchObject([{ model: "opus-5", mean: 4.5, weight: 6 }]);
  });
});

describe("scope partitioning", () => {
  test("evidence, priors and revisions never cross BATON_CONFIG_DIR scopes", () => {
    const personal = scopeStore("scope-personal");
    const enterprise = scopeStore("scope-enterprise");

    seedPriors(personal, "daniel", [{ model: "kimi-k3", mean: 5 }], at(0));
    grade(personal, { grade: 5 });

    expect(effectiveRatings(enterprise, at(0))).toEqual([]);
    expect(activeProfile(enterprise)).toBeNull();
    expect(revision(enterprise)).toBe(0);
    expect(revision(personal)).toBe(2);
  });
});
