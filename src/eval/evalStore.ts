import type { Database } from "bun:sqlite";

import { AUTONOMY_ORDER, type Autonomy } from "../adapters/types.ts";
import { nowIso, withBusyRetry } from "../store/store.ts";
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
} from "./decay.ts";
import {
  DEFAULT_HALF_LIFE_DAYS,
  DEFAULT_PRIOR_WEIGHT,
  PRIOR_WEIGHT_CAP,
  SETTING_ACTIVE_PROFILE,
  SETTING_HALF_LIFE_DAYS,
  SETTING_PROFILE_WEIGHT,
  SETTING_RATINGS_REVISION,
  type Accumulator,
  type EffectiveRating,
  type Prior,
} from "./types.ts";

/**
 * The eval store (PLAN.md §Evaluation, ratings, profiles). Storage roles stay
 * separated: grades are the raw private record, the accumulator holds observed
 * evidence only, priors are explicit and provenance-tagged, and nothing here
 * mixes the two — `effectiveRatings` blends them at read time and reports both.
 *
 * Every mutation that the ratings projection is made of commits inside one
 * BEGIN IMMEDIATE together with the revision bump, so the ratings.yaml
 * publisher can never render a half-applied state (PLAN.md §Publication
 * protocol). Reliability is target-private and not part of that projection, so
 * it commits without bumping.
 */

export interface GradeInput {
  runId: string;
  /** 1–5, consumer-assigned. */
  grade: number;
  notes?: string;
  category?: string;
  /** Execution-target fingerprint the evidence attaches to. */
  target: string;
  /** Canonical model, for the rollup. */
  model: string;
  /** When the run happened — late grades weigh from here, not from now. */
  runAt: string;
  /** Defaults to now; explicit only for deterministic tests and replays. */
  gradedAt?: string;
}

/**
 * Records (or replaces) a grade and folds it into the accumulator. Re-grading a
 * run REPLACES its grade: the previous event is subtracted with the weight it
 * has decayed to by now — exactly cancelling its contribution — before the new
 * one is added, so a correction can never double-count.
 *
 * An event that arrives out of order (a replay, a backdated report) is folded in
 * at the accumulator's own `as_of`, never behind it: the run's time still sets
 * the event's weight, but the "now" the aggregate decays to has to be monotonic
 * or the decay-forward identity breaks and the removal cancels the wrong amount.
 * Late-arriving events are therefore treated as arriving now.
 */
export function recordGrade(db: Database, input: GradeInput): number {
  const grade = validGrade(input.grade);
  const now = input.gradedAt ?? nowIso();
  const category = input.category ?? "";
  return inTransaction(db, () => {
    const hl = halfLifeMsFor(db);
    const prev = db
      .query<
        { grade: number; run_at: string; target: string; category: string; model: string },
        [string]
      >("SELECT grade, run_at, target, category, model FROM grades WHERE run_id = ?")
      .get(input.runId);
    if (prev) {
      const old = loadAccumulator(db, prev.target, prev.category, prev.model);
      saveAccumulator(
        db,
        removeGradeEvent(old, prev.grade, prev.run_at, laterOf(now, old.asOf), hl),
      );
    }
    const acc = loadAccumulator(db, input.target, category, input.model);
    saveAccumulator(db, addGradeEvent(acc, grade, input.runAt, laterOf(now, acc.asOf), hl));
    db.query(
      `INSERT INTO grades (run_id, grade, notes, category, target, model, run_at, graded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id) DO UPDATE SET
         grade = excluded.grade, notes = excluded.notes, category = excluded.category,
         target = excluded.target, model = excluded.model, run_at = excluded.run_at,
         graded_at = excluded.graded_at`,
    ).run(
      input.runId,
      grade,
      input.notes ?? null,
      category,
      input.target,
      input.model,
      input.runAt,
      now,
    );
    return bumpRevision(db);
  });
}

export interface Reliability {
  target: string;
  sumWOk: number;
  sumWFail: number;
  /** Decayed success rate, or null with no observations. */
  rate: number | null;
}

/**
 * Adapter/parse failures are reliability against the *target*, never quality
 * against the model (PLAN.md §Layering and sharing). Same decay rule, including
 * the monotonic `as_of`: an out-of-order outcome lands at the row's own time
 * instead of rewinding it, which would re-decay everything already counted.
 */
export function recordReliability(db: Database, target: string, ok: boolean, at = nowIso()): void {
  inTransaction(db, () => {
    const row = readReliability(db, target);
    const now = row ? laterOf(at, row.as_of) : at;
    const f = row ? decayFactor(row.as_of, now, halfLifeMsFor(db)) : 1;
    const sumWOk = (row?.sum_w_ok ?? 0) * f + (ok ? 1 : 0);
    const sumWFail = (row?.sum_w_fail ?? 0) * f + (ok ? 0 : 1);
    db.query(
      `INSERT INTO reliability (target, sum_w_ok, sum_w_fail, as_of) VALUES (?, ?, ?, ?)
       ON CONFLICT (target) DO UPDATE SET
         sum_w_ok = excluded.sum_w_ok, sum_w_fail = excluded.sum_w_fail, as_of = excluded.as_of`,
    ).run(target, sumWOk, sumWFail, now);
  });
}

export function reliabilityFor(db: Database, target: string, at = nowIso()): Reliability {
  const row = readReliability(db, target);
  if (!row) return { target, sumWOk: 0, sumWFail: 0, rate: null };
  const f = decayFactor(row.as_of, at, halfLifeMsFor(db));
  const sumWOk = row.sum_w_ok * f;
  const sumWFail = row.sum_w_fail * f;
  const total = sumWOk + sumWFail;
  return { target, sumWOk, sumWFail, rate: total > 0 ? sumWOk / total : null };
}

export interface PriorEntry {
  model: string;
  category?: string;
  mean: number;
  /** Pseudo-observations; defaults to DEFAULT_PRIOR_WEIGHT, capped on write. */
  weight?: number;
  /**
   * When this opinion was formed. Defaults to the write time; a shared profile
   * carries its own per-entry as_of, and re-stamping it on import would claim
   * the numbers are fresher than they are (PLAN.md §Layering: import with
   * decayed as_of).
   */
  asOf?: string;
}

/** "~5–10 observations" (PLAN.md §Seeded priors) — the low end is the default. */
export { DEFAULT_PRIOR_WEIGHT };

export interface SeedResult {
  revision: number;
  /** Exactly what was stored — defaults and the cap applied. */
  entries: PriorRef[];
}

/**
 * Onboarding seeds. Weight is capped at write time so a wrong seed cannot steer
 * routing for months; the profile becomes active only if no profile is. The
 * stored entries come back so the confirmation the user approves against is the
 * store's own answer, not a caller's re-derivation of the same rules.
 */
export function seedPriors(
  db: Database,
  profile: string,
  entries: PriorEntry[],
  at = nowIso(),
): SeedResult {
  const result = writePriors(db, profile, entries, "seeded", at, { activateIfUnset: true });
  return { revision: result.revision, entries: result.stored };
}

export interface PriorRef {
  model: string;
  category: string;
  mean: number;
  weight: number;
}

export interface PriorChange extends PriorRef {
  /** What the profile held before the import — `as_of` included, because a
   * prior's precision decays from it, so moving it reweights the prior. */
  previous: { mean: number; weight: number; source: string; asOf: string };
}

/** Import shows a summary diff, never silently reweights (PLAN.md §Layering). */
export interface ImportDiff {
  profile: string;
  source: string;
  revision: number;
  added: PriorRef[];
  changed: PriorChange[];
  unchanged: PriorRef[];
  /** Priors the profile held that the document does not (replace mode only). */
  removed: PriorRef[];
}

export interface ImportOptions {
  /** Make the profile equal to the document: priors it does not name are deleted. */
  replace?: boolean;
}

/**
 * Imports a shared profile under `imported:<source>` provenance. Does NOT
 * activate it: the diff is for the user to look at before switching.
 */
export function importPriors(
  db: Database,
  profile: string,
  entries: PriorEntry[],
  source: string,
  at = nowIso(),
  opts: ImportOptions = {},
): ImportDiff {
  const { stored: _stored, ...result } = writePriors(db, profile, entries, `imported:${source}`, at, {
    activateIfUnset: false,
    replace: opts.replace ?? false,
  });
  return { profile, source, ...result };
}

export interface PriorDiff {
  added: PriorRef[];
  changed: PriorChange[];
  unchanged: PriorRef[];
  removed: PriorRef[];
}

export interface DiffOptions {
  /** Provenance the write would stamp; omitted leaves source out of the compare. */
  source?: string;
  /** Time entries without their own as_of would be stamped with; omitted leaves
   * those entries' as_of out of the compare. */
  at?: string;
  /** Report priors the entries do not name as removed (what a replacing write deletes). */
  replace?: boolean;
}

/**
 * What writing these entries into `profile` would change — read-only, so a dry
 * run does not have to mutate the store to describe itself. `importPriors`
 * reports exactly this diff after the write; the CLI shows it before one.
 *
 * "Unchanged" means every field a write would store is already stored, `as_of`
 * and provenance included: a re-import that only refreshes as_of restores the
 * prior's decayed precision, and one that only changes source relabels where
 * the numbers came from. Reporting either as unchanged would be the silent
 * reweighting the import diff exists to prevent (PLAN.md §Layering and sharing).
 */
export function diffPriors(
  db: Database,
  profile: string,
  entries: PriorEntry[],
  opts: DiffOptions = {},
): PriorDiff {
  return diffNormalized(db, profile, entries.map(normalizeEntry), opts);
}

interface NormalizedEntry extends PriorRef {
  asOf?: string;
}

function normalizeEntry(e: PriorEntry): NormalizedEntry {
  return {
    model: e.model,
    category: e.category ?? "",
    mean: validGrade(e.mean),
    weight: cappedWeight(e.weight),
    ...(e.asOf === undefined ? {} : { asOf: e.asOf }),
  };
}

interface PriorRow extends PriorRef {
  source: string;
  as_of: string;
}

function diffNormalized(
  db: Database,
  profile: string,
  entries: NormalizedEntry[],
  opts: DiffOptions,
): PriorDiff {
  const existing = new Map(
    db
      .query<PriorRow, [string]>(
        "SELECT model, category, mean, weight, source, as_of FROM priors WHERE profile = ?",
      )
      .all(profile)
      .map((r) => [priorKey(r.model, r.category), r] as const),
  );
  const diff: PriorDiff = { added: [], changed: [], unchanged: [], removed: [] };
  const named = new Set(entries.map((e) => priorKey(e.model, e.category)));
  if (opts.replace) {
    for (const [key, row] of existing) {
      if (!named.has(key)) {
        diff.removed.push({ model: row.model, category: row.category, mean: row.mean, weight: row.weight });
      }
    }
  }
  for (const { asOf, ...ref } of entries) {
    const before = existing.get(priorKey(ref.model, ref.category));
    const next = asOf ?? opts.at;
    if (!before) diff.added.push(ref);
    else if (
      before.mean !== ref.mean ||
      before.weight !== ref.weight ||
      (next !== undefined && before.as_of !== next) ||
      (opts.source !== undefined && before.source !== opts.source)
    ) {
      diff.changed.push({
        ...ref,
        previous: {
          mean: before.mean,
          weight: before.weight,
          source: before.source,
          asOf: before.as_of,
        },
      });
    } else diff.unchanged.push(ref);
  }
  return diff;
}

/** NUL separator: neither a model id nor a category can contain one. */
function priorKey(model: string, category: string): string {
  return `${model}\u0000${category}`;
}

interface WriteResult extends PriorDiff {
  revision: number;
  /** The entries as stored, in the order they were given. */
  stored: PriorRef[];
}

function writePriors(
  db: Database,
  profile: string,
  entries: PriorEntry[],
  source: string,
  at: string,
  opts: { activateIfUnset: boolean; replace?: boolean },
): WriteResult {
  const normalized = entries.map(normalizeEntry);
  return inTransaction(db, () => {
    const diff = diffNormalized(db, profile, normalized, { source, at, replace: opts.replace });
    for (const gone of diff.removed) {
      db.query("DELETE FROM priors WHERE profile = ? AND model = ? AND category = ?").run(
        profile,
        gone.model,
        gone.category,
      );
    }
    const stored: PriorRef[] = [];
    for (const { asOf, ...entry } of normalized) {
      stored.push(entry);
      db.query(
        `INSERT INTO priors (profile, model, category, mean, weight, source, as_of)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (profile, model, category) DO UPDATE SET
           mean = excluded.mean, weight = excluded.weight,
           source = excluded.source, as_of = excluded.as_of`,
      ).run(profile, entry.model, entry.category, entry.mean, entry.weight, source, asOf ?? at);
    }
    if (opts.activateIfUnset && !readSetting(db, SETTING_ACTIVE_PROFILE)) {
      writeSetting(db, SETTING_ACTIVE_PROFILE, profile);
    }
    return { ...diff, stored, revision: bumpRevision(db) };
  });
}

export function activeProfile(db: Database): string | null {
  return readSetting(db, SETTING_ACTIVE_PROFILE) ?? null;
}

/** Switching profiles swaps the prior; nothing observed is overwritten. */
export function setActiveProfile(db: Database, name: string): number {
  return inTransaction(db, () => {
    writeSetting(db, SETTING_ACTIVE_PROFILE, name);
    return bumpRevision(db);
  });
}

export function revision(db: Database): number {
  return Number.parseInt(readSetting(db, SETTING_RATINGS_REVISION) ?? "0", 10) || 0;
}

export interface RatingSettingOptions {
  /**
   * Wipe the accumulator, reliability and duel-edge tables so a new half-life
   * starts from empty aggregates. Required to change `half_life_days` once any
   * of them holds evidence — see `setRatingSetting`.
   */
  resetEvidence?: boolean;
}

/**
 * Writes a setting that changes what the ratings projection says (half-life,
 * profile weight) and bumps the revision in the same transaction. Without the
 * bump the publisher would discard the refreshed render as stale, because no
 * eval table changed (PLAN.md §Publication protocol).
 *
 * `half_life_days` is special: the accumulator stores decayed sums, not the
 * events behind them, so its numbers only mean anything under the half-life
 * they were folded in with. Changing it silently would reinterpret every stored
 * sum under a curve it never followed — and a later re-grade would subtract a
 * weight the original event never carried. So it is refused while evidence
 * exists unless the caller asks to drop that evidence, which happens in this
 * same transaction. The duel edge map (`bt_edges`) stores decayed sums under
 * exactly the same rule and is therefore part of "evidence" on both sides of
 * this guard — a scope whose only evidence is duels used to be allowed through,
 * silently corrupting every edge. The grades ring buffer and duel verdicts are
 * private history rather than decayed sums, and are left alone.
 */
export function setRatingSetting(
  db: Database,
  key: string,
  value: string,
  opts: RatingSettingOptions = {},
): number {
  return inTransaction(db, () => {
    if (key === SETTING_HALF_LIFE_DAYS && value !== readSetting(db, SETTING_HALF_LIFE_DAYS)) {
      if (opts.resetEvidence) {
        db.exec("DELETE FROM accumulator");
        db.exec("DELETE FROM reliability");
        db.exec("DELETE FROM bt_edges");
      } else if (hasEvidence(db)) {
        throw new Error(
          `Cannot change ${SETTING_HALF_LIFE_DAYS} while this scope holds observed evidence: the accumulator, the reliability counters and the duel edge map all store sums already decayed at the current half-life, and reinterpreting them under a new one corrupts every rating. Re-run with --reset-evidence to discard those three aggregates (graded runs and duel verdicts themselves are kept).`,
        );
      }
    }
    writeSetting(db, key, value);
    return bumpRevision(db);
  });
}

/** Sums that were folded in under the current half-life and cannot be reread. */
function hasEvidence(db: Database): boolean {
  return (
    db
      .query<{ n: number }, []>(
        `SELECT (SELECT COUNT(*) FROM accumulator)
              + (SELECT COUNT(*) FROM reliability)
              + (SELECT COUNT(*) FROM bt_edges) AS n`,
      )
      .get()!.n > 0
  );
}

/**
 * Splits an execution-target fingerprint into the route the registry minted
 * (`<app>:<instance>/<slug>@a<adapterVersion>+v<appVersion>`) and the autonomy
 * level the supervisor appended. A tail that is not an autonomy level is part
 * of the route: fingerprints written before a component existed keep their old
 * shape and simply age out by decay, so this must never mistake a version
 * segment for an authority level.
 */
export function splitTarget(target: string): { route: string; autonomy: Autonomy | "" } {
  const plus = target.lastIndexOf("+");
  const tail = plus === -1 ? "" : target.slice(plus + 1);
  return (AUTONOMY_ORDER as string[]).includes(tail)
    ? { route: target.slice(0, plus), autonomy: tail as Autonomy }
    : { route: target, autonomy: "" };
}

/** Observed evidence for one execution target, decayed to the read time. */
export interface TargetRating {
  target: string;
  /** `target` without the autonomy segment: the route evidence belongs to. */
  route: string;
  /** Autonomy the evidence was produced at; "" when the fingerprint predates it. */
  autonomy: Autonomy | "";
  model: string;
  category: string;
  /** Decayed mean, or null with no evidence left. */
  observed: number | null;
  /** Decayed Σw — how much evidence this is, for shrinkage to the rollup. */
  weight: number;
  nEff: number;
}

/**
 * Per-target observed evidence, decayed read-side without writing. The
 * canonical model's rating (effectiveRatings) is the rollup across these; this
 * is the level ratings actually attach to (PLAN.md §Registry: execution
 * target), and what lets selection prefer the harness or instance that has been
 * answering well rather than treating every route to a model as identical.
 * `route`/`autonomy` are the split fingerprint, so a lens can ask for evidence
 * at the authority level a candidate would actually run at.
 */
export function targetRatings(db: Database, at = nowIso()): TargetRating[] {
  const hl = halfLifeMsFor(db);
  return db
    .query<AccumulatorRow, []>(
      `SELECT target, model, category, sum_wg, sum_w, sum_w2, n, as_of
       FROM accumulator ORDER BY target, category`,
    )
    .all()
    .map((row) => {
      const acc = decayAccumulator(fromRow(row), at, hl);
      return {
        target: acc.target,
        ...splitTarget(acc.target),
        model: acc.model,
        category: acc.category,
        observed: mean(acc),
        weight: acc.sumW,
        nEff: nEff(acc),
      };
    });
}

/**
 * Effective ratings per (canonical model, category). Observed evidence is the
 * rollup across that model's execution targets — each target row decayed to
 * `at` read-side, without writing — and the prior comes from the active
 * profile, decayed from *its own* as_of and scaled by the profile weight.
 * Prior-only models appear with `observed: null` so "unrated but seeded" stays
 * visible as exactly that.
 *
 * The prior decays on the same curve as observed evidence (PLAN.md §Decay:
 * "priors, whose own precision decays from *their* as_of"). Without that, a
 * year-old imported opinion would keep its full pseudo-observations forever and
 * outrank fresh local evidence — which is precisely what PRIOR_WEIGHT_CAP is
 * meant to prevent. `priorWeight` reports the decayed weight, so what selection
 * actually blended is what get_ratings and ratings.yaml show.
 */
export function effectiveRatings(db: Database, at = nowIso()): EffectiveRating[] {
  const hl = halfLifeMsFor(db);
  const merged = new Map<string, Accumulator>();
  for (const row of db
    .query<AccumulatorRow, []>(
      "SELECT target, model, category, sum_wg, sum_w, sum_w2, n, as_of FROM accumulator",
    )
    .all()) {
    const decayed = decayAccumulator(fromRow(row), at, hl);
    const key = `${row.model}\u0000${row.category}`;
    const acc = merged.get(key);
    if (!acc) merged.set(key, { ...decayed, target: "*" });
    else {
      acc.sumWg += decayed.sumWg;
      acc.sumW += decayed.sumW;
      acc.sumW2 += decayed.sumW2;
      acc.n += decayed.n;
    }
  }

  const scale = profileWeight(db);
  const priors = new Map<string, Prior>(
    activePriors(db).map((p) => [`${p.model}\u0000${p.category}`, p] as const),
  );

  const ratings: EffectiveRating[] = [];
  for (const key of new Set([...merged.keys(), ...priors.keys()])) {
    const acc = merged.get(key);
    const prior = priors.get(key);
    const [model = "", category = ""] = key.split("\u0000");
    const observed = acc ? mean(acc) : null;
    const priorWeight = prior ? prior.weight * decayFactor(prior.asOf, at, hl) * scale : 0;
    ratings.push({
      model,
      category,
      observed,
      nEff: acc ? nEff(acc) : 0,
      prior: prior?.mean ?? null,
      priorWeight,
      blended: blend(observed, acc?.sumW ?? 0, prior?.mean ?? null, priorWeight),
    });
  }
  return ratings.sort((a, b) => a.model.localeCompare(b.model) || a.category.localeCompare(b.category));
}

/** Priors of the active profile, unscaled and as stored. */
export function activePriors(db: Database): Prior[] {
  const profile = activeProfile(db);
  if (!profile) return [];
  return db
    .query<
      {
        profile: string;
        model: string;
        category: string;
        mean: number;
        weight: number;
        source: string;
        as_of: string;
      },
      [string]
    >(
      `SELECT profile, model, category, mean, weight, source, as_of
       FROM priors WHERE profile = ? ORDER BY model, category`,
    )
    .all(profile)
    .map(({ as_of, ...prior }) => ({ ...prior, asOf: as_of }));
}

export function halfLifeMsFor(db: Database): number {
  const days = Number.parseFloat(readSetting(db, SETTING_HALF_LIFE_DAYS) ?? "");
  return halfLifeMs(days > 0 ? days : DEFAULT_HALF_LIFE_DAYS);
}

/** Multiplier on the active profile's prior weights. Scales at read; the cap
 * is a write-time property of the stored prior. */
export function profileWeight(db: Database): number {
  const value = Number.parseFloat(readSetting(db, SETTING_PROFILE_WEIGHT) ?? "");
  return Number.isFinite(value) && value >= 0 ? value : 1;
}

interface AccumulatorRow {
  target: string;
  model: string;
  category: string;
  sum_wg: number;
  sum_w: number;
  sum_w2: number;
  n: number;
  as_of: string;
}

function fromRow(row: AccumulatorRow): Accumulator {
  return {
    target: row.target,
    model: row.model,
    category: row.category,
    sumWg: row.sum_wg,
    sumW: row.sum_w,
    sumW2: row.sum_w2,
    n: row.n,
    asOf: row.as_of,
  };
}

function loadAccumulator(
  db: Database,
  target: string,
  category: string,
  model: string,
): Accumulator {
  const row = db
    .query<AccumulatorRow, [string, string]>(
      `SELECT target, model, category, sum_wg, sum_w, sum_w2, n, as_of
       FROM accumulator WHERE target = ? AND category = ?`,
    )
    .get(target, category);
  return row
    ? { ...fromRow(row), model }
    : { target, model, category, sumWg: 0, sumW: 0, sumW2: 0, n: 0, asOf: new Date(0).toISOString() };
}

function saveAccumulator(db: Database, acc: Accumulator): void {
  db.query(
    `INSERT INTO accumulator (target, model, category, sum_wg, sum_w, sum_w2, n, as_of)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (target, category) DO UPDATE SET
       model = excluded.model, sum_wg = excluded.sum_wg, sum_w = excluded.sum_w,
       sum_w2 = excluded.sum_w2, n = excluded.n, as_of = excluded.as_of`,
  ).run(acc.target, acc.model, acc.category, acc.sumWg, acc.sumW, acc.sumW2, acc.n, acc.asOf);
}

interface ReliabilityRow {
  sum_w_ok: number;
  sum_w_fail: number;
  as_of: string;
}

function readReliability(db: Database, target: string): ReliabilityRow | null {
  return db
    .query<ReliabilityRow, [string]>(
      "SELECT sum_w_ok, sum_w_fail, as_of FROM reliability WHERE target = ?",
    )
    .get(target);
}

function readSetting(db: Database, key: string): string | undefined {
  return db
    .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?")
    .get(key)?.value;
}

function writeSetting(db: Database, key: string, value: string): void {
  db.query(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/**
 * Monotonic, in the same transaction as the outcome it publishes. Exported so
 * duels bump the same counter through the same three lines rather than a
 * second copy of them.
 */
export function bumpRevision(db: Database): number {
  const next = revision(db) + 1;
  writeSetting(db, SETTING_RATINGS_REVISION, String(next));
  return next;
}

function validGrade(grade: number): number {
  if (!Number.isFinite(grade) || grade < 1 || grade > 5) {
    throw new Error(`Grade must be a number between 1 and 5, got ${grade}.`);
  }
  return grade;
}

function cappedWeight(weight: number | undefined): number {
  const w = weight ?? DEFAULT_PRIOR_WEIGHT;
  if (!Number.isFinite(w) || w < 0) {
    throw new Error(`Prior weight must be a non-negative number, got ${weight}.`);
  }
  return Math.min(w, PRIOR_WEIGHT_CAP);
}

/**
 * BEGIN IMMEDIATE ... COMMIT with busy retry. Local by design: store.ts owns
 * the schema, this module owns its own write discipline.
 */
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
