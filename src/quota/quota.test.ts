import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensurePaths, resolvePaths } from "../config/paths.ts";
import { openStore } from "../store/store.ts";
import {
  backoffMs,
  clearCooldown,
  coolingUntil,
  dropRunEvent,
  EVENT_RETENTION_MS,
  headroomFor,
  pruneQuotaEvents,
  recordAdmissionFailure,
  recordRun,
  snapshot,
} from "./quota.ts";
import { COOLDOWN_BASE_MS, COOLDOWN_CAP_MS, WINDOW_SHORT_MS, WINDOW_WEEK_MS } from "./types.ts";

/** A throwaway BATON_CONFIG_DIR scope. Never touches a real Baton dir. */
function scopeStore(name: string): Database {
  const root = mkdtempSync(join(tmpdir(), `baton-${name}-`));
  return openStore(ensurePaths(resolvePaths({ BATON_CONFIG_DIR: root })).dbPath);
}

const T0 = Date.parse("2026-08-24T12:00:00.000Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const MINUTE = 60_000;

const events = (db: Database) =>
  db
    .query<{ app: string; instance: string; kind: string; tokens: number | null; detail: string | null }, []>(
      "SELECT app, instance, kind, tokens, detail FROM quota_events ORDER BY id",
    )
    .all();

describe("recordRun", () => {
  test("records a run event per instance, with tokens when the CLI reports them", () => {
    const db = scopeStore("quota-run");
    recordRun(db, "claude-code", "personal-2", at(0), 1234);
    recordRun(db, "claude-code", "default", at(MINUTE));

    expect(events(db)).toEqual([
      { app: "claude-code", instance: "personal-2", kind: "run", tokens: 1234, detail: null },
      { app: "claude-code", instance: "default", kind: "run", tokens: null, detail: null },
    ]);
  });

  test("timestamps are normalised so window comparisons stay ordered", () => {
    const db = scopeStore("quota-iso");
    recordRun(db, "kimi", "default", "2026-08-24T14:00:00+02:00");
    expect(db.query<{ at: string }, []>("SELECT at FROM quota_events").get()!.at).toBe(
      "2026-08-24T12:00:00.000Z",
    );
    expect(() => recordRun(db, "kimi", "default", "whenever")).toThrow("Invalid timestamp");
  });
});

describe("recordAdmissionFailure — cooldowns", () => {
  test("consecutive strikes back off exponentially and cap", () => {
    const db = scopeStore("quota-backoff");
    const untils: number[] = [];
    while (untils.length < 8) {
      const until = recordAdmissionFailure(db, "claude-code", "personal-2", at(0), "429");
      untils.push(Date.parse(until) - T0);
    }

    expect(untils.slice(0, 4)).toEqual([
      COOLDOWN_BASE_MS,
      COOLDOWN_BASE_MS * 2,
      COOLDOWN_BASE_MS * 4,
      COOLDOWN_BASE_MS * 8,
    ]);
    expect(untils.at(-1)).toBe(COOLDOWN_CAP_MS);
    expect(Math.max(...untils)).toBe(COOLDOWN_CAP_MS);
    expect(backoffMs(1)).toBe(COOLDOWN_BASE_MS);
    expect(backoffMs(99)).toBe(COOLDOWN_CAP_MS);

    const row = db
      .query<{ strikes: number; reason: string }, []>("SELECT strikes, reason FROM cooldowns")
      .get()!;
    expect(row).toEqual({ strikes: 8, reason: "429" });
    expect(events(db).every((e) => e.kind === "admission_failure")).toBe(true);
  });

  test("a parseable reset time from the CLI overrides the backoff", () => {
    const db = scopeStore("quota-reset");
    const reset = at(90 * MINUTE);
    expect(recordAdmissionFailure(db, "claude-code", "a", at(0), "limit", reset)).toBe(reset);
    // A later refusal with an unparseable reset still cannot pull the deadline in.
    expect(recordAdmissionFailure(db, "claude-code", "a", at(0), "limit", "in a while")).toBe(reset);
  });

  test("a second refusal never shortens a deadline the provider already set", () => {
    const db = scopeStore("quota-no-shorten");
    // The CLI said "an hour"; ten minutes later it refuses again, silently.
    const reset = at(60 * MINUTE);
    expect(recordAdmissionFailure(db, "claude-code", "a", at(0), "limit", reset)).toBe(reset);
    expect(recordAdmissionFailure(db, "claude-code", "a", at(10 * MINUTE), "limit")).toBe(reset);
    expect(coolingUntil(db, "claude-code", "a", at(30 * MINUTE))).toBe(reset);

    // The strike still counted, so a refusal after the hour backs off further
    // rather than starting over at the base delay.
    expect(recordAdmissionFailure(db, "claude-code", "a", at(60 * MINUTE), "limit")).toBe(
      at(60 * MINUTE + COOLDOWN_BASE_MS * 4),
    );
  });

  test("cooldowns are per (app, instance) — one failing account does not cool the pool", () => {
    const db = scopeStore("quota-scoped");
    recordAdmissionFailure(db, "claude-code", "a", at(0));
    expect(coolingUntil(db, "claude-code", "a", at(MINUTE))).toBe(at(COOLDOWN_BASE_MS));
    expect(coolingUntil(db, "claude-code", "b", at(MINUTE))).toBeUndefined();
    expect(coolingUntil(db, "kimi", "a", at(MINUTE))).toBeUndefined();
  });
});

describe("clearCooldown", () => {
  test("a successful run clears the row and ends the strike chain", () => {
    const db = scopeStore("quota-clear");
    recordAdmissionFailure(db, "claude-code", "a", at(0));
    recordAdmissionFailure(db, "claude-code", "a", at(MINUTE));

    expect(clearCooldown(db, "claude-code", "a")).toBe(true);
    expect(coolingUntil(db, "claude-code", "a", at(2 * MINUTE))).toBeUndefined();
    expect(clearCooldown(db, "claude-code", "a")).toBe(false);

    // The next failure starts over at the base delay, not at strike 3.
    expect(recordAdmissionFailure(db, "claude-code", "a", at(10 * MINUTE))).toBe(
      at(10 * MINUTE + COOLDOWN_BASE_MS),
    );
  });
});

describe("coolingUntil", () => {
  test("stops blocking once elapsed but keeps the strike chain", () => {
    const db = scopeStore("quota-cooling");
    const until = recordAdmissionFailure(db, "claude-code", "a", at(0));

    expect(coolingUntil(db, "claude-code", "a", at(COOLDOWN_BASE_MS - 1))).toBe(until);
    // Exactly at the reset instant the instance is usable again...
    expect(coolingUntil(db, "claude-code", "a", at(COOLDOWN_BASE_MS))).toBeUndefined();
    // ...but the strike is remembered: only a successful run ends the chain, so
    // an instance that refuses once per cooldown does back off.
    expect(db.query<{ strikes: number }, []>("SELECT strikes FROM cooldowns").get()!.strikes).toBe(
      1,
    );
    expect(recordAdmissionFailure(db, "claude-code", "a", at(COOLDOWN_BASE_MS))).toBe(
      at(COOLDOWN_BASE_MS + 2 * COOLDOWN_BASE_MS),
    );
  });
});

describe("recordRun / dropRunEvent", () => {
  test("a refused admission gives its provisional window slot back", () => {
    const db = scopeStore("quota-refund");
    // The slot is claimed the moment the callee is spawned...
    const id = recordRun(db, "claude-code", "a", at(0));
    expect(snapshot(db, "claude-code", "a", at(MINUTE)).runsShort).toBe(1);

    // ...and given back when the spawn turns out to have been refused.
    expect(dropRunEvent(db, id)).toBe(true);
    expect(dropRunEvent(db, id)).toBe(false);
    expect(snapshot(db, "claude-code", "a", at(MINUTE)).runsShort).toBe(0);

    // Only 'run' events are refundable: an admission failure is not usage.
    recordAdmissionFailure(db, "claude-code", "a", at(0), "429");
    const failureId = db.query<{ id: number }, []>("SELECT id FROM quota_events").get()!.id;
    expect(dropRunEvent(db, failureId)).toBe(false);
  });
});

describe("snapshot — window counting", () => {
  test("counts inclusively at each window edge and excludes anything older", () => {
    const db = scopeStore("quota-windows");
    const now = at(WINDOW_WEEK_MS + 1);
    const nowMs = Date.parse(now);
    const stamp = (agoMs: number) => new Date(nowMs - agoMs).toISOString();

    recordRun(db, "claude-code", "a", stamp(0));
    recordRun(db, "claude-code", "a", stamp(WINDOW_SHORT_MS)); // on the 5h edge
    recordRun(db, "claude-code", "a", stamp(WINDOW_SHORT_MS + 1)); // just outside
    recordRun(db, "claude-code", "a", stamp(WINDOW_WEEK_MS)); // on the weekly edge
    recordRun(db, "claude-code", "a", stamp(WINDOW_WEEK_MS + 1)); // just outside

    const snap = snapshot(db, "claude-code", "a", now);
    expect(snap.runsShort).toBe(2);
    expect(snap.runsWeek).toBe(4);
    expect(snap.app).toBe("claude-code");
    expect(snap.instance).toBe("a");
    expect(snap.coolingUntil).toBeUndefined();
  });

  test("only 'run' events consume a window; admission failures are not usage", () => {
    const db = scopeStore("quota-kinds");
    recordRun(db, "claude-code", "a", at(0));
    recordAdmissionFailure(db, "claude-code", "a", at(MINUTE));

    const snap = snapshot(db, "claude-code", "a", at(2 * MINUTE));
    expect(snap.runsShort).toBe(1);
    expect(snap.runsWeek).toBe(1);
    expect(snap.coolingUntil).toBe(at(MINUTE + COOLDOWN_BASE_MS));
  });

  test("counts are per instance, so spreading has something to compare", () => {
    const db = scopeStore("quota-per-instance");
    recordRun(db, "claude-code", "a", at(0));
    recordRun(db, "claude-code", "a", at(MINUTE));
    recordRun(db, "claude-code", "b", at(MINUTE));

    const now = at(2 * MINUTE);
    expect(snapshot(db, "claude-code", "a", now).runsShort).toBe(2);
    expect(snapshot(db, "claude-code", "b", now).runsShort).toBe(1);
    expect(snapshot(db, "claude-code", "b", now).headroom).toBeGreaterThan(
      snapshot(db, "claude-code", "a", now).headroom,
    );
  });
});

describe("headroom", () => {
  test("an untouched instance reads 1 and every count strictly lowers it", () => {
    expect(headroomFor(0, 0)).toBe(1);

    let previous = headroomFor(0, 0);
    for (let runs = 1; runs <= 50; runs++) {
      const next = headroomFor(runs, runs);
      expect(next).toBeLessThan(previous);
      expect(next).toBeGreaterThan(0);
      expect(next).toBeLessThanOrEqual(1);
      previous = next;
    }
  });

  test("each window contributes independently and equally", () => {
    expect(headroomFor(1, 0)).toBeLessThan(headroomFor(0, 0));
    expect(headroomFor(0, 1)).toBeLessThan(headroomFor(0, 0));
    // Same relative pressure in either window ⇒ same headroom (equal blend).
    expect(headroomFor(8, 0)).toBeCloseTo(headroomFor(0, 80), 12);
  });

  test("observed runs move a snapshot's headroom monotonically down", () => {
    const db = scopeStore("quota-headroom");
    const readings: number[] = [];
    for (let i = 0; i < 6; i++) {
      readings.push(snapshot(db, "claude-code", "a", at(i * MINUTE)).headroom);
      recordRun(db, "claude-code", "a", at(i * MINUTE));
    }
    expect(readings[0]).toBe(1);
    expect(readings).toEqual([...readings].sort((x, y) => y - x));
    expect(new Set(readings).size).toBe(readings.length);
  });
});

describe("pruneQuotaEvents", () => {
  test("drops observations older than the retention window, keeps the rest", () => {
    const db = scopeStore("quota-prune");
    const now = at(2 * EVENT_RETENTION_MS);
    const nowMs = Date.parse(now);
    const stamp = (agoMs: number) => new Date(nowMs - agoMs).toISOString();

    recordRun(db, "claude-code", "a", stamp(EVENT_RETENTION_MS + 1));
    recordAdmissionFailure(db, "claude-code", "a", stamp(EVENT_RETENTION_MS + MINUTE));
    recordRun(db, "claude-code", "a", stamp(EVENT_RETENTION_MS)); // on the edge, kept
    recordRun(db, "claude-code", "a", stamp(MINUTE));

    expect(pruneQuotaEvents(db, now)).toBe(2);
    expect(events(db).length).toBe(2);
    // Pruning never touches live cooldown state.
    expect(db.query("SELECT app FROM cooldowns").get()).toBeTruthy();
    expect(pruneQuotaEvents(db, now)).toBe(0);
  });
});
