import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { AdapterSpec, ExecResult } from "../adapters/types.ts";
import type { Target } from "../registry/registry.ts";
import { openStore } from "../store/store.ts";
import { Supervisor, type AdapterExec } from "../supervisor/supervisor.ts";
import type { BtRating } from "./duelTypes.ts";
import { revision, seedPriors } from "./evalStore.ts";
import { PRIOR_WEIGHT_CAP } from "./types.ts";
import {
  btRatings,
  currentEdges,
  duelView,
  reportDuel,
  startDuel,
  type DuelRequest,
} from "./duels.ts";

/**
 * No real CLI and no child process: the supervisor is driven through its
 * injectable resolver + exec seam, exactly as supervisor.test.ts does. The
 * resolver hands out a target per model, so the fake exec can tell the two
 * sides apart by slug.
 */

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function newDb(): Database {
  const dir = `/tmp/baton-duels-${crypto.randomUUID()}`;
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return openStore(join(dir, "baton.db"));
}

const SPEC: AdapterSpec = {
  app: "fake",
  adapterVersion: 1,
  binary: "/bin/true",
  models: [],
  invoke: { argv: [], promptVia: "stdin", extract: { kind: "text" } },
  autonomyFlags: { readonly: [], edits: [], full: [] },
  defaultAutonomy: "full",
  defaultTimeoutMs: 10_000,
  admissionFailurePatterns: [],
};

function targetFor(model: string): Target {
  return {
    spec: SPEC,
    slug: model,
    instance: "default",
    binaryPath: SPEC.binary,
    targetFingerprint: `fake:default/${model}@a1`,
  };
}

function ok(slug: string): ExecResult {
  return {
    ok: true,
    started: true,
    output: `answer from ${slug}`,
    exitCode: 0,
    timedOut: false,
    rawTail: "",
    durationMs: 1,
  };
}

function boom(slug: string): ExecResult {
  return {
    ok: false,
    started: true,
    exitCode: 1,
    timedOut: false,
    rawTail: "",
    error: `${slug} blew up`,
    durationMs: 1,
  };
}

interface Harness {
  db: Database;
  supervisor: Supervisor;
  /** Every ExecRequest the supervisor issued, so identical-payload is checkable. */
  calls: { slug: string; prompt: string; cwd: string; timeoutMs: number }[];
}

function harness(
  exec: (slug: string) => Promise<ExecResult>,
  known: (model: string) => boolean = () => true,
): Harness {
  const db = newDb();
  const calls: Harness["calls"] = [];
  const adapterExec: AdapterExec = async (req) => {
    calls.push({
      slug: req.slug,
      prompt: req.prompt,
      cwd: req.cwd,
      timeoutMs: req.timeoutMs,
    });
    return exec(req.slug);
  };
  const supervisor = new Supervisor({
    db,
    env: {},
    hostCwd: "/tmp",
    resolver: {
      resolve: (model) => {
        if (!known(model)) throw new Error(`No usable route for '${model}'.`);
        return targetFor(model);
      },
    },
    exec: adapterExec,
    pollMs: 5,
  });
  return { db, supervisor, calls };
}

const ALPHA = "alpha-model";
const OMEGA = "omega-model"; // ALPHA < OMEGA lexicographically.

function request(over: Partial<DuelRequest> = {}): DuelRequest {
  return { models: [ALPHA, OMEGA], prompt: "Refactor this function.", category: "impl", ...over };
}

async function settle(h: Harness, runIds: string[]): Promise<void> {
  for (const id of runIds) await h.supervisor.waitForRun(id, 2_000);
}

async function ready(h: Harness, req = request()) {
  const view = await startDuel({ db: h.db, supervisor: h.supervisor }, req);
  await settle(h, view.runs.map((r) => r.runId));
  return duelView(h.db, h.supervisor, view.duelId);
}

/** The randomized assignment, read from the row the caller cannot see. */
function labelsOf(db: Database, duelId: string): { A: string; B: string } {
  const row = db
    .query<{ label_map: string }, [string]>("SELECT label_map FROM duels WHERE id = ?")
    .get(duelId)!;
  return JSON.parse(row.label_map) as { A: string; B: string };
}

interface EdgeRow {
  model_a: string;
  model_b: string;
  category: string;
  wins_a: number;
  wins_b: number;
  ties: number;
  mass2: number;
  as_of: string;
}

function edges(db: Database): EdgeRow[] {
  return db.query<EdgeRow, []>("SELECT * FROM bt_edges").all();
}

function duelCreatedAt(db: Database, duelId: string): string {
  return db
    .query<{ created_at: string }, [string]>("SELECT created_at FROM duels WHERE id = ?")
    .get(duelId)!.created_at;
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("startDuel", () => {
  test("runs both sides on one identical payload and records the duel", async () => {
    const h = harness(async (slug) => ok(slug));
    const view = await ready(h);

    expect(view.status).toBe("awaiting_judgment");
    expect(view.category).toBe("impl");
    expect(view.runs.map((r) => r.label)).toEqual(["A", "B"]);

    // Identical prompt/cwd/budget on both sides; the model name is never in it.
    expect(h.calls).toHaveLength(2);
    expect(new Set(h.calls.map((c) => c.slug))).toEqual(new Set([ALPHA, OMEGA]));
    for (const call of h.calls) {
      expect(call.prompt).toBe("Refactor this function.");
      expect(call.cwd).toBe("/tmp");
      expect(call.timeoutMs).toBe(10_000);
    }
    const prompts = h.db
      .query<{ prompt: string; cwd: string }, []>("SELECT prompt, cwd FROM runs")
      .all();
    expect(prompts).toEqual([
      { prompt: "Refactor this function.", cwd: "/tmp" },
      { prompt: "Refactor this function.", cwd: "/tmp" },
    ]);
  });

  test("refuses a model duelling itself, launching nothing", async () => {
    const h = harness(async (slug) => ok(slug));
    await expect(
      startDuel({ db: h.db, supervisor: h.supervisor }, request({ models: [ALPHA, ALPHA] })),
    ).rejects.toThrow(/two different models/);
    expect(h.calls).toHaveLength(0);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n).toBe(0);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM duels").get()!.n).toBe(0);
  });

  test("an unresolvable second model cancels the side already launched", async () => {
    const h = harness(
      async (slug) => ok(slug),
      (model) => model !== "ghost-model",
    );
    await expect(
      startDuel({ db: h.db, supervisor: h.supervisor }, request({ models: [ALPHA, "ghost-model"] })),
    ).rejects.toThrow(/ghost-model/);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM duels").get()!.n).toBe(0);
    for (const run of h.db.query<{ status: string }, []>("SELECT status FROM runs").all()) {
      expect(run.status).toBe("cancelled");
    }
  });

  test("assigns labels randomly across duels", async () => {
    const h = harness(async (slug) => ok(slug));
    h.db.query("INSERT INTO settings (key, value) VALUES ('max_concurrent', '100')").run();
    const seen = new Set<string>();
    for (let i = 0; i < 24; i++) {
      const view = await startDuel({ db: h.db, supervisor: h.supervisor }, request());
      seen.add(labelsOf(h.db, view.duelId).A);
      await settle(h, view.runs.map((r) => r.runId));
    }
    expect(seen).toEqual(new Set([ALPHA, OMEGA]));
  });
});

describe("duelView", () => {
  test("never reveals the models before judgment", async () => {
    const h = harness(async (slug) => ok(slug));
    const view = await ready(h);
    const json = JSON.stringify(view);
    expect(json).not.toContain(ALPHA);
    expect(json).not.toContain(OMEGA);
    expect(view.revealed).toBeUndefined();
    expect(view.winner).toBeUndefined();
  });

  test("is running while a side is still working, and refuses judgment", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness(async (slug) => {
      await gate;
      return ok(slug);
    });
    const view = await startDuel({ db: h.db, supervisor: h.supervisor }, request());
    expect(duelView(h.db, h.supervisor, view.duelId).status).toBe("running");
    expect(() => reportDuel(h.db, view.duelId, "A")).toThrow(/still running/);

    release();
    await settle(h, view.runs.map((r) => r.runId));
    expect(duelView(h.db, h.supervisor, view.duelId).status).toBe("awaiting_judgment");
  });

  test("rejects an unknown duel", () => {
    const h = harness(async (slug) => ok(slug));
    expect(() => duelView(h.db, h.supervisor, "duel_nope")).toThrow(/Unknown duel/);
  });
});

describe("reportDuel", () => {
  test("reveals the mapping and writes the winner's edge", async () => {
    const h = harness(async (slug) => ok(slug));
    const view = await ready(h);
    const map = labelsOf(h.db, view.duelId);

    const reported = reportDuel(h.db, view.duelId, "A", duelCreatedAt(h.db, view.duelId));
    expect(reported.status).toBe("reported");
    expect(reported.winner).toBe("A");
    expect(reported.revealed).toEqual(map);
    expect(duelView(h.db, h.supervisor, view.duelId).revealed).toEqual(map);

    const [edge] = edges(h.db);
    expect(edge).toMatchObject({
      model_a: ALPHA,
      model_b: OMEGA,
      category: "impl",
      wins_a: map.A === ALPHA ? 1 : 0,
      wins_b: map.A === ALPHA ? 0 : 1,
      ties: 0,
      // Σw² of the one event behind the edge, for the Kish nEff.
      mass2: 1,
    });
  });

  /**
   * Sol #2: a tie used to be stored as half a win each way AND a tie, which the
   * fitter then split again — one tie carried twice the comparison mass of a
   * decisive duel. One duel is one unit of mass; the TIE_WEIGHT split lives in
   * the fitter alone.
   */
  test("a tie is one directionless comparison, not half a win each way", async () => {
    const h = harness(async (slug) => ok(slug));
    const view = await ready(h);
    reportDuel(h.db, view.duelId, "tie", duelCreatedAt(h.db, view.duelId));

    expect(edges(h.db)[0]).toMatchObject({ wins_a: 0, wins_b: 0, ties: 1, mass2: 1 });
  });

  test("re-reporting replaces the previous judgment exactly", async () => {
    const h = harness(async (slug) => ok(slug));
    const view = await ready(h);
    const map = labelsOf(h.db, view.duelId);
    const at = duelCreatedAt(h.db, view.duelId);

    reportDuel(h.db, view.duelId, "A", at);
    reportDuel(h.db, view.duelId, "B", at);

    // The A-side contribution is gone, not merely outweighed.
    expect(edges(h.db)[0]).toMatchObject({
      wins_a: map.B === ALPHA ? 1 : 0,
      wins_b: map.B === ALPHA ? 0 : 1,
      ties: 0,
    });

    reportDuel(h.db, view.duelId, "tie", at);
    expect(edges(h.db)[0]).toMatchObject({ wins_a: 0, wins_b: 0, ties: 1, mass2: 1 });
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM bt_edges").get()!.n).toBe(1);
    expect(
      h.db.query<{ winner: string }, []>("SELECT winner FROM duels").get()!.winner,
    ).toBe("tie");
  });

  test("retracts a decayed judgment at the weight it has decayed to", async () => {
    const h = harness(async (slug) => ok(slug));
    const view = await ready(h);
    const map = labelsOf(h.db, view.duelId);
    const at = duelCreatedAt(h.db, view.duelId);
    const oneHalfLife = new Date(Date.parse(at) + 90 * DAY_MS).toISOString();

    reportDuel(h.db, view.duelId, "A", at);
    reportDuel(h.db, view.duelId, "B", oneHalfLife);

    // Edge decayed to 0.5, the retraction removes exactly that, and the new
    // verdict enters weighted from the duel's own time (also 0.5).
    const edge = edges(h.db)[0]!;
    const winnerSide = map.B === ALPHA ? edge.wins_a : edge.wins_b;
    const loserSide = map.B === ALPHA ? edge.wins_b : edge.wins_a;
    expect(loserSide).toBeCloseTo(0, 12);
    expect(winnerSide).toBeCloseTo(0.5, 12);
    expect(edge.as_of).toBe(oneHalfLife);
    // Σw² decayed by the square and the retraction cancelled exactly, so the
    // faded duel is still worth exactly one effective comparison.
    expect(edge.mass2).toBeCloseTo(0.25, 12);
    expect(0.5 ** 2 / edge.mass2).toBeCloseTo(1, 12);
  });

  test("bumps the ratings revision", async () => {
    const h = harness(async (slug) => ok(slug));
    const view = await ready(h);
    const before = revision(h.db);
    reportDuel(h.db, view.duelId, "A");
    expect(revision(h.db)).toBe(before + 1);
    reportDuel(h.db, view.duelId, "tie");
    expect(revision(h.db)).toBe(before + 2);
  });

  test("keeps duels of different categories on separate edges", async () => {
    const h = harness(async (slug) => ok(slug));
    const impl = await ready(h, request({ category: "impl" }));
    const review = await ready(h, request({ category: "review" }));
    reportDuel(h.db, impl.duelId, "A");
    reportDuel(h.db, review.duelId, "B");

    expect(edges(h.db).map((e) => e.category).sort()).toEqual(["impl", "review"]);
  });

  test("rejects a winner that is not A, B or tie", async () => {
    const h = harness(async (slug) => ok(slug));
    const view = await ready(h);
    expect(() =>
      reportDuel(h.db, view.duelId, "winner" as unknown as "A"),
    ).toThrow(/must be 'A', 'B' or 'tie'/);
  });
});

describe("btRatings", () => {
  const BETA = "beta-model";
  const GAMMA = "gamma-model";

  const ratingOf = (rows: BtRating[], model: string, category: string) => {
    const row = rows.find((r) => r.model === model && r.category === category);
    if (!row) throw new Error(`no BT rating for ${model}/${category}`);
    return row;
  };

  /** Both duels reported at their own creation time: every weight is exactly 1. */
  async function judged(h: Harness, models: [string, string], winner: "A" | "B" | "tie") {
    const view = await ready(h, request({ models, category: "impl" }));
    reportDuel(h.db, view.duelId, winner, duelCreatedAt(h.db, view.duelId));
    return duelCreatedAt(h.db, view.duelId);
  }

  /**
   * Sol #2, exactly: one decisive duel and one tie must be worth the same. The
   * tie used to be stored as 0.5/0.5/1 — two units of mass — and nEff was the
   * raw mass, so a tie counted double and every duel counted as one comparison
   * however faded it was.
   */
  test("a tie and a decisive duel each contribute exactly one comparison", async () => {
    const h = harness(async (slug) => ok(slug));
    h.db.query("INSERT INTO settings (key, value) VALUES ('max_concurrent', '100')").run();
    const first = await judged(h, [ALPHA, OMEGA], "A");
    const second = await judged(h, [BETA, GAMMA], "tie");
    const at = second > first ? second : first;

    for (const e of currentEdges(h.db, at)) {
      expect(e.winsA + e.winsB + e.ties).toBeCloseTo(1, 6);
    }
    for (const r of btRatings(h.db, at)) {
      expect(r.nEff).toBeCloseTo(1, 6);
    }
  });

  test("resolves the prior per category, not one flattened mean per model", async () => {
    const h = harness(async (slug) => ok(slug));
    h.db.query("INSERT INTO settings (key, value) VALUES ('max_concurrent', '100')").run();
    seedPriors(h.db, "daniel", [
      { model: ALPHA, category: "impl", mean: 5, weight: PRIOR_WEIGHT_CAP },
      { model: ALPHA, category: "review", mean: 1, weight: PRIOR_WEIGHT_CAP },
    ]);

    const impl = await ready(h, request({ category: "impl" }));
    reportDuel(h.db, impl.duelId, "tie", duelCreatedAt(h.db, impl.duelId));
    const review = await ready(h, request({ category: "review" }));
    reportDuel(h.db, review.duelId, "tie", duelCreatedAt(h.db, review.duelId));

    const bt = btRatings(h.db);
    // Same neutral evidence in both categories: the ordering is the priors'.
    expect(ratingOf(bt, ALPHA, "impl").theta).toBeGreaterThan(0);
    expect(ratingOf(bt, ALPHA, "review").theta).toBeLessThan(0);
  });

  test("falls back to the uncategorised prior where the category has none", async () => {
    const h = harness(async (slug) => ok(slug));
    seedPriors(h.db, "daniel", [{ model: OMEGA, mean: 5, weight: PRIOR_WEIGHT_CAP }]);
    const view = await ready(h, request({ category: "impl" }));
    reportDuel(h.db, view.duelId, "tie", duelCreatedAt(h.db, view.duelId));

    const bt = btRatings(h.db);
    expect(ratingOf(bt, OMEGA, "impl").theta).toBeGreaterThan(
      ratingOf(bt, ALPHA, "impl").theta,
    );
  });

  /** A prior's precision decays from its own as_of (PLAN.md §Decay). */
  test("a stale prior pulls less than a fresh one on identical evidence", async () => {
    const pull = async (asOf: string) => {
      const h = harness(async (slug) => ok(slug));
      seedPriors(h.db, "daniel", [
        { model: OMEGA, category: "impl", mean: 5, weight: PRIOR_WEIGHT_CAP, asOf },
      ]);
      const view = await ready(h, request({ category: "impl" }));
      const at = duelCreatedAt(h.db, view.duelId);
      reportDuel(h.db, view.duelId, "tie", at);
      return ratingOf(btRatings(h.db, at), OMEGA, "impl").theta;
    };

    const now = new Date();
    const fresh = await pull(now.toISOString());
    const stale = await pull(new Date(now.getTime() - 5 * 90 * DAY_MS).toISOString());
    expect(fresh).toBeGreaterThan(stale);
    expect(stale).toBeGreaterThan(0);
  });

  test("a thin prior pulls less than a capped one", async () => {
    const pull = async (weight: number) => {
      const h = harness(async (slug) => ok(slug));
      seedPriors(h.db, "daniel", [{ model: OMEGA, category: "impl", mean: 5, weight }]);
      const view = await ready(h, request({ category: "impl" }));
      const at = duelCreatedAt(h.db, view.duelId);
      reportDuel(h.db, view.duelId, "tie", at);
      return ratingOf(btRatings(h.db, at), OMEGA, "impl").theta;
    };
    expect(await pull(PRIOR_WEIGHT_CAP)).toBeGreaterThan(await pull(1));
  });
});

describe("a failed side voids the duel", () => {
  test("never produces an edge, however the other side did", async () => {
    const h = harness(async (slug) => (slug === OMEGA ? boom(slug) : ok(slug)));
    const view = await ready(h);

    expect(view.status).toBe("failed");
    expect(view.revealed).toBeUndefined();
    expect(() => reportDuel(h.db, view.duelId, "A")).toThrow(/void/);
    expect(edges(h.db)).toHaveLength(0);
    expect(h.db.query<{ winner: string | null }, []>("SELECT winner FROM duels").get()!.winner).toBe(
      null,
    );
  });

  test("a run evicted from the ring buffer is void, not judgeable", async () => {
    const h = harness(async (slug) => ok(slug));
    const view = await ready(h);
    const gone = view.runs[1]!.runId;
    h.db.query("DELETE FROM attempts WHERE run_id = ?").run(gone);
    h.db.query("DELETE FROM runs WHERE id = ?").run(gone);

    expect(duelView(h.db, h.supervisor, view.duelId).status).toBe("failed");
  });
});
