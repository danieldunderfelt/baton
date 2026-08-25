import type { Database } from "bun:sqlite";

import { newId, nowIso, withBusyRetry } from "../store/store.ts";
import type { RunOptions, RunRequest, RunStatus, RunView } from "../supervisor/types.ts";
import { fitBradleyTerry } from "./bradleyTerry.ts";
import { decayFactor, laterOf, weightAt } from "./decay.ts";
import { TIE_WEIGHT, type BtEdge, type BtRating, type DuelView } from "./duelTypes.ts";
import { activePriors, bumpRevision, halfLifeMsFor } from "./evalStore.ts";

/**
 * Blind duels (PLAN.md §Evaluation): both sides run through the ordinary
 * supervisor with an IDENTICAL prompt, options and cwd — the model name is
 * never written into the prompt, and nothing beyond the two runs is retained
 * (their prompts live in the run ring buffer like any other run's).
 *
 * A duel is one row plus the two runs it points at. `run_a`/`model_a` are what
 * label A got; the randomized assignment is therefore recorded by *which* model
 * landed in `model_a`, and `label_map` is the explicit reveal record read back
 * after judgment. Until then the caller only ever sees labels.
 */

export type Winner = "A" | "B" | "tie";

/** The slice of the supervisor a duel needs — the real one satisfies it. */
export interface DuelSupervisor {
  startRun(req: RunRequest): Promise<{ view: RunView; settled: Promise<void> }>;
  getRun(runId: string): RunView | undefined;
  cancelRun(runId: string): void;
}

export interface DuelDeps {
  db: Database;
  supervisor: DuelSupervisor;
}

export interface DuelRequest {
  /** The two models to compare; must be distinct and resolvable. */
  models: [string, string];
  prompt: string;
  category?: string;
  cwd?: string;
  options?: RunOptions;
}

/** Terminal statuses that void a duel: a side that never answered cannot lose. */
const FAILED: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "failed",
  "timeout",
  "cancelled",
  "orphaned",
]);

/**
 * Launches both sides and records the duel. Label assignment is a crypto coin
 * flip, so the caller cannot infer the mapping from the request order.
 *
 * The second launch failing (an unresolvable model, a concurrency cap) cancels
 * the first: half a duel is not evidence, and leaving it running would burn a
 * quota window for an answer nobody will ever judge.
 */
export async function startDuel(deps: DuelDeps, req: DuelRequest): Promise<DuelView> {
  const [first, second] = req.models;
  if (first === second) {
    throw new Error(
      `A duel needs two different models, got '${first}' twice. Compare a model against another route with an explicit target instead.`,
    );
  }
  const labels = coinFlip() ? { A: first, B: second } : { A: second, B: first };
  // Identical everything: the only difference between the two runs is the model.
  const shared = {
    prompt: req.prompt,
    ...(req.cwd === undefined ? {} : { cwd: req.cwd }),
    ...(req.category === undefined ? {} : { category: req.category }),
    ...(req.options === undefined ? {} : { options: req.options }),
  };

  const a = await deps.supervisor.startRun({ model: labels.A, ...shared });
  let b: { view: RunView; settled: Promise<void> };
  try {
    b = await deps.supervisor.startRun({ model: labels.B, ...shared });
  } catch (err) {
    deps.supervisor.cancelRun(a.view.runId);
    throw err;
  }
  // The runs settle on their own; a duel is polled through duelView().
  void a.settled.catch(() => {});
  void b.settled.catch(() => {});

  const duelId = newId("duel");
  const createdAt = nowIso();
  withBusyRetry(() =>
    deps.db
      .query(
        `INSERT INTO duels (id, category, model_a, model_b, run_a, run_b, label_map, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        duelId,
        req.category ?? "",
        labels.A,
        labels.B,
        a.view.runId,
        b.view.runId,
        JSON.stringify(labels),
        createdAt,
      ),
  );

  return duelView(deps.db, deps.supervisor, duelId);
}

/**
 * The duel as it stands. Status is derived from the runs live rather than
 * stored, so a side that died after the duel was recorded shows up as `failed`
 * without anything having to notice at the time.
 */
export function duelView(db: Database, supervisor: DuelSupervisor, duelId: string): DuelView {
  const row = readDuel(db, duelId);
  return viewOf(row, duelStatus(row, (id) => supervisor.getRun(id)?.status));
}

function viewOf(row: DuelRow, status: DuelView["status"]): DuelView {
  return {
    duelId: row.id,
    category: row.category,
    runs: [
      { label: "A", runId: row.run_a },
      { label: "B", runId: row.run_b },
    ],
    status,
    ...(row.winner ? { winner: row.winner } : {}),
    ...(status === "reported" ? { revealed: labelMap(row) } : {}),
    createdAt: row.created_at,
  };
}

/**
 * Records the judgment and folds it into the pairwise edge map. Re-reporting
 * REPLACES the previous verdict: the old contribution is subtracted with the
 * weight it has decayed to by now — exactly cancelling it, as re-grading does —
 * before the new one is added, so a correction can never double-count.
 *
 * The revision bumps in the same transaction as the edge, so the ratings.yaml
 * publisher can never render a half-applied judgment (PLAN.md §Publication).
 */
export function reportDuel(
  db: Database,
  duelId: string,
  winner: Winner,
  at = nowIso(),
): DuelView {
  if (winner !== "A" && winner !== "B" && winner !== "tie") {
    throw new Error(`Duel winner must be 'A', 'B' or 'tie', got '${String(winner)}'.`);
  }
  const row = readDuel(db, duelId);
  // The store, not a supervisor: judgment can arrive from a process that never
  // launched these runs (a CLI, a later MCP session), and run status is in SQLite.
  const status = duelStatus(row, (id) => runStatus(db, id));
  if (status !== "awaiting_judgment" && status !== "reported") {
    throw new Error(
      status === "failed"
        ? `Duel ${duelId} is void: one of its runs failed, so there is nothing to compare. Start a new duel.`
        : `Duel ${duelId} is still running — judge it once both sides have answered.`,
    );
  }

  const map = labelMap(row);
  const [modelA, modelB] = [map.A, map.B].sort() as [string, string];
  inTransaction(db, () => {
    const hl = halfLifeMsFor(db);
    const edge = loadEdge(db, modelA, modelB, row.category);
    // The edge's clock never rewinds: an out-of-order report lands at the row's
    // own time, or the removal below would cancel the wrong amount.
    const now = laterOf(at, edge.asOf);
    const f = decayFactor(edge.asOf, now, hl);
    // The duel's own time, not the report's: a late judgment weighs from when
    // the comparison actually happened.
    const w = weightAt(Date.parse(now) - Date.parse(row.created_at), hl);
    // Re-read under the write lock: two reports racing on the same duel must
    // not both retract the same previous verdict and both add their own.
    const previous = readDuel(db, duelId).winner;
    const before = previous ? outcome(previous, map, modelA) : ZERO;
    const after = outcome(winner, map, modelA);
    saveEdge(db, {
      modelA,
      modelB,
      category: row.category,
      winsA: clamp(edge.winsA * f + w * (after.a - before.a)),
      winsB: clamp(edge.winsB * f + w * (after.b - before.b)),
      ties: clamp(edge.ties * f + w * (after.ties - before.ties)),
      asOf: now,
    });
    db.query("UPDATE duels SET winner = ?, reported_at = ? WHERE id = ?").run(winner, at, duelId);
    bumpRevision(db);
  });

  return viewOf({ ...row, winner }, "reported");
}

interface EdgeState {
  modelA: string;
  modelB: string;
  category: string;
  winsA: number;
  winsB: number;
  ties: number;
  asOf: string;
}

interface Contribution {
  a: number;
  b: number;
  ties: number;
}

const ZERO: Contribution = { a: 0, b: 0, ties: 0 };

/**
 * One judgment as edge mass, in the edge's own (lexicographic) orientation. A
 * tie is half a win each way (TIE_WEIGHT) and is also counted as a tie, which
 * is what the comparison mass behind a BT fit is made of.
 */
function outcome(winner: Winner, map: LabelMap, modelA: string): Contribution {
  if (winner === "tie") return { a: TIE_WEIGHT, b: TIE_WEIGHT, ties: 1 };
  const won = map[winner];
  return won === modelA ? { a: 1, b: 0, ties: 0 } : { a: 0, b: 1, ties: 0 };
}

interface DuelRow {
  id: string;
  category: string;
  model_a: string;
  model_b: string;
  run_a: string;
  run_b: string;
  label_map: string;
  winner: Winner | null;
  created_at: string;
}

function readDuel(db: Database, duelId: string): DuelRow {
  const row = db
    .query<DuelRow, [string]>(
      `SELECT id, category, model_a, model_b, run_a, run_b, label_map, winner, created_at
       FROM duels WHERE id = ?`,
    )
    .get(duelId);
  if (!row) throw new Error(`Unknown duel '${duelId}'.`);
  return row;
}

/**
 * A reported duel stays reported; otherwise a missing or terminally failed run
 * voids it — including a run the ring buffer has since evicted, which can no
 * longer be shown to have succeeded.
 */
function duelStatus(
  row: DuelRow,
  statusOf: (runId: string) => RunStatus | undefined,
): DuelView["status"] {
  if (row.winner) return "reported";
  const statuses = [statusOf(row.run_a), statusOf(row.run_b)];
  if (statuses.some((s) => s === undefined || FAILED.has(s))) return "failed";
  return statuses.every((s) => s === "succeeded") ? "awaiting_judgment" : "running";
}

function runStatus(db: Database, runId: string): RunStatus | undefined {
  return db
    .query<{ status: RunStatus }, [string]>("SELECT status FROM runs WHERE id = ?")
    .get(runId)?.status;
}

type LabelMap = { A: string; B: string };

/** The columns are the mapping; `label_map` is the same thing, readable. */
function labelMap(row: DuelRow): LabelMap {
  return { A: row.model_a, B: row.model_b };
}

interface EdgeRow {
  model_a: string;
  model_b: string;
  category: string;
  wins_a: number;
  wins_b: number;
  ties: number;
  as_of: string;
}

/** The stored edge, or an empty one dated at the epoch so the first fold-in
 * decays nothing. */
function loadEdge(db: Database, modelA: string, modelB: string, category: string): EdgeState {
  const row = db
    .query<EdgeRow, [string, string, string]>(
      `SELECT wins_a, wins_b, ties, as_of FROM bt_edges
       WHERE model_a = ? AND model_b = ? AND category = ?`,
    )
    .get(modelA, modelB, category);
  return {
    modelA,
    modelB,
    category,
    winsA: row?.wins_a ?? 0,
    winsB: row?.wins_b ?? 0,
    ties: row?.ties ?? 0,
    asOf: row?.as_of ?? new Date(0).toISOString(),
  };
}

function saveEdge(db: Database, edge: EdgeState): void {
  db.query(
    `INSERT INTO bt_edges (model_a, model_b, category, wins_a, wins_b, ties, as_of)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (model_a, model_b, category) DO UPDATE SET
       wins_a = excluded.wins_a, wins_b = excluded.wins_b,
       ties = excluded.ties, as_of = excluded.as_of`,
  ).run(edge.modelA, edge.modelB, edge.category, edge.winsA, edge.winsB, edge.ties, edge.asOf);
}

/**
 * The edge map decayed to read time. Edges are stored decayed-forward to their
 * own `as_of` (PLAN.md §Decay), so every reader owes the same residual factor
 * before fitting — one implementation of that rule, not one per surface.
 */
export function currentEdges(db: Database, at = nowIso()): BtEdge[] {
  const hl = halfLifeMsFor(db);
  return db
    .query<
      {
        model_a: string;
        model_b: string;
        category: string;
        wins_a: number;
        wins_b: number;
        ties: number;
        as_of: string;
      },
      []
    >(
      `SELECT model_a, model_b, category, wins_a, wins_b, ties, as_of
       FROM bt_edges ORDER BY category, model_a, model_b`,
    )
    .all()
    .map((row) => {
      const f = decayFactor(row.as_of, at, hl);
      return {
        modelA: row.model_a,
        modelB: row.model_b,
        category: row.category,
        winsA: row.wins_a * f,
        winsB: row.wins_b * f,
        ties: row.ties * f,
        asOf: at,
      };
    });
}

/**
 * The regularized Bradley-Terry fit over the current edges, shrunk toward the
 * active profile's canonical priors. Reported as a SEPARATE signal from the
 * grade EMAs — never merged into `blended` (PLAN.md §Layering and sharing).
 */
export function btRatings(db: Database, at = nowIso()): BtRating[] {
  return fitBradleyTerry(currentEdges(db, at), priorMeans(db));
}

/**
 * Prior mean per model for the shrinkage pseudo-edge. The fit takes one mean
 * per model, not per category, so an uncategorised seed ("kimi-k3 is a 4")
 * wins; a model seeded only per category lends its first such opinion rather
 * than dropping to the neutral anchor.
 */
function priorMeans(db: Database): Map<string, number> {
  const means = new Map<string, number>();
  for (const prior of activePriors(db)) {
    if (prior.category === "" || !means.has(prior.model)) means.set(prior.model, prior.mean);
  }
  return means;
}

/** Floating-point residue after a retraction is not evidence. */
function clamp(value: number): number {
  return value > 0 ? value : 0;
}

/** Unbiased enough for a coin flip, and unguessable by the caller. */
function coinFlip(): boolean {
  return (crypto.getRandomValues(new Uint8Array(1))[0]! & 1) === 1;
}

/** BEGIN IMMEDIATE ... COMMIT with busy retry; the same discipline evalStore uses. */
function inTransaction<T>(db: Database, fn: () => T): T {
  return withBusyRetry(() => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // SQLite already rolled back; the original error is what matters.
      }
      throw err;
    }
  });
}
