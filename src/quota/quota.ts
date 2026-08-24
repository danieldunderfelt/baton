import type { Database } from "bun:sqlite";

import { withBusyRetry } from "../store/store.ts";
import {
  COOLDOWN_BASE_MS,
  COOLDOWN_CAP_MS,
  WINDOW_SHORT_MS,
  WINDOW_WEEK_MS,
  type QuotaSnapshot,
} from "./types.ts";

/**
 * Quota observation and admission-failure cooldowns (PLAN.md §Quota-aware cost,
 * §Instance pools). Baton observes what happens rather than modelling provider
 * quotas: run counts per instance in the active scope's own DB, plus cooldowns
 * minted when a CLI refuses admission.
 */

/**
 * Soft caps that turn observed run counts into a *relative* headroom signal.
 * These are not quota claims — no CLI tells us the real budget. They set the
 * curve's knee: at the soft cap an instance's headroom halves, so spreading
 * favours the less-used member long before anything is actually exhausted.
 * Named exports so tuning them is visible rather than buried in a formula.
 */
export const SHORT_WINDOW_SOFT_CAP = 8;
export const WEEK_WINDOW_SOFT_CAP = 80;

/** Events outlive the weekly window by a day, then they are noise. */
export const EVENT_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * Records a run against an instance's windows, returning the event's id.
 * Written the moment the callee is admitted (not when it finishes), so a
 * selection made while this run is still in flight already sees the slot it
 * took — otherwise concurrent selections all read the same headroom and pile
 * onto one instance (PLAN.md §Proactive spreading). Tokens when the CLI
 * reports them.
 */
export function recordRun(
  db: Database,
  app: string,
  instance: string,
  atIso: string,
  tokens?: number,
): number {
  return Number(
    db
      .query("INSERT INTO quota_events (app, instance, at, kind, tokens) VALUES (?, ?, ?, 'run', ?)")
      .run(app, instance, iso(atIso), tokens ?? null).lastInsertRowid,
  );
}

/**
 * Un-records a run event: the spawn turned out to be an admission refusal, so
 * the window slot it provisionally claimed was never spent.
 */
export function dropRunEvent(db: Database, id: number): boolean {
  return db.query("DELETE FROM quota_events WHERE id = ? AND kind = 'run'").run(id).changes > 0;
}

/**
 * A rate-limit/auth refusal *before* the callee started work: records the event
 * and puts the instance on cooldown. A parseable reset time from the CLI sets
 * the deadline; otherwise consecutive strikes back off exponentially to
 * COOLDOWN_CAP_MS.
 * Returns the ISO instant the instance is cooling until.
 *
 * A new failure never *shortens* an existing deadline: when the provider said
 * "an hour", a second refusal ten minutes later is that same hour speaking
 * again, and a fresh short backoff would send the next run straight back into
 * the wall. The later of the two instants wins.
 */
export function recordAdmissionFailure(
  db: Database,
  app: string,
  instance: string,
  atIso: string,
  detail?: string,
  resetAtIso?: string,
): string {
  const at = iso(atIso);
  const reset = parseIso(resetAtIso);
  return withBusyRetry(() =>
    db.transaction(() => {
      db.query(
        "INSERT INTO quota_events (app, instance, at, kind, detail) VALUES (?, ?, ?, 'admission_failure', ?)",
      ).run(app, instance, at, detail ?? null);
      const existing = cooldownRow(db, app, instance);
      const strikes = (existing?.strikes ?? 0) + 1;
      const proposed = reset ?? new Date(Date.parse(at) + backoffMs(strikes)).toISOString();
      const until = laterOf(existing?.until, proposed);
      db.query(
        `INSERT INTO cooldowns (app, instance, until, strikes, reason) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (app, instance) DO UPDATE
           SET until = excluded.until, strikes = excluded.strikes, reason = excluded.reason`,
      ).run(app, instance, until, strikes, detail ?? null);
      return until;
    })(),
  );
}

/** The later of two instants; the second one when there is no first. */
function laterOf(existing: string | undefined, proposed: string): string {
  if (existing === undefined) return proposed;
  return Date.parse(existing) > Date.parse(proposed) ? existing : proposed;
}

/** COOLDOWN_BASE_MS * 2^(strikes−1), capped. */
export function backoffMs(strikes: number): number {
  return Math.min(COOLDOWN_BASE_MS * 2 ** (strikes - 1), COOLDOWN_CAP_MS);
}

/**
 * A successful run proves admission works again, so the strike chain ends —
 * the ONLY thing that ends it. The supervisor calls this on success; strikes
 * compound until an instance actually admits work again.
 */
export function clearCooldown(db: Database, app: string, instance: string): boolean {
  return (
    db.query("DELETE FROM cooldowns WHERE app = ? AND instance = ?").run(app, instance).changes > 0
  );
}

/**
 * The instant this instance is cooling until, or undefined when it is usable.
 * An elapsed cooldown stops blocking the instance but its row stays: the strike
 * count is what a *repeated* refusal backs off from, and deleting it on expiry
 * would restart every chain at the base delay — an instance that refuses once
 * per cooldown would then never back off at all.
 */
export function coolingUntil(
  db: Database,
  app: string,
  instance: string,
  nowIso: string,
): string | undefined {
  const row = cooldownRow(db, app, instance);
  if (!row) return undefined;
  return Date.parse(row.until) > Date.parse(iso(nowIso)) ? row.until : undefined;
}

/** Observed state of one instance's windows at `nowIso`. */
export function snapshot(
  db: Database,
  app: string,
  instance: string,
  nowIso: string,
): QuotaSnapshot {
  const now = Date.parse(iso(nowIso));
  const runsShort = countRuns(db, app, instance, now - WINDOW_SHORT_MS);
  const runsWeek = countRuns(db, app, instance, now - WINDOW_WEEK_MS);
  const cooling = coolingUntil(db, app, instance, nowIso);
  return {
    app,
    instance,
    runsShort,
    runsWeek,
    ...(cooling ? { coolingUntil: cooling } : {}),
    headroom: headroomFor(runsShort, runsWeek),
  };
}

/**
 * Relative headroom in (0, 1]: both windows decay as 1/(1 + runs/softCap) and
 * are blended equally, so a burst inside the 5-hour window and a slow weekly
 * drain both push selection elsewhere. Monotonically decreasing in either
 * count, never zero — an untouched instance reads 1.
 */
export function headroomFor(runsShort: number, runsWeek: number): number {
  const short = 1 / (1 + runsShort / SHORT_WINDOW_SOFT_CAP);
  const week = 1 / (1 + runsWeek / WEEK_WINDOW_SOFT_CAP);
  return (short + week) / 2;
}

/** Drops observations no window can still see. Cheap enough to call on open. */
export function pruneQuotaEvents(db: Database, nowIso: string): number {
  const cutoff = new Date(Date.parse(iso(nowIso)) - EVENT_RETENTION_MS).toISOString();
  return db.query("DELETE FROM quota_events WHERE at < ?").run(cutoff).changes;
}

/** Window edges are inclusive: an event exactly at the cutoff still counts. */
function countRuns(db: Database, app: string, instance: string, sinceMs: number): number {
  return (
    db
      .query<{ n: number }, [string, string, string]>(
        "SELECT COUNT(*) AS n FROM quota_events WHERE app = ? AND instance = ? AND kind = 'run' AND at >= ?",
      )
      .get(app, instance, new Date(sinceMs).toISOString())?.n ?? 0
  );
}

function cooldownRow(
  db: Database,
  app: string,
  instance: string,
): { until: string; strikes: number } | undefined {
  return (
    db
      .query<{ until: string; strikes: number }, [string, string]>(
        "SELECT until, strikes FROM cooldowns WHERE app = ? AND instance = ?",
      )
      .get(app, instance) ?? undefined
  );
}

/**
 * Timestamps are stored in one canonical form because every window query is a
 * string comparison — a stray offset or missing millis would silently
 * mis-order rows.
 */
function iso(value: string): string {
  const parsed = parseIso(value);
  if (parsed === undefined) throw new Error(`Invalid timestamp '${value}'.`);
  return parsed;
}

/** Reset times come from CLI output, which is untrusted and often unparseable. */
function parseIso(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}
