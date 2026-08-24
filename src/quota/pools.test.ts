import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensurePaths, resolvePaths } from "../config/paths.ts";
import { nowIso, openStore } from "../store/store.ts";
import {
  candidatesFor,
  clearPool,
  getPool,
  listPools,
  preciousnessFor,
  preciousnessKey,
  removeFromPools,
  setPool,
} from "./pools.ts";
import { recordAdmissionFailure, recordRun } from "./quota.ts";
import { COOLDOWN_BASE_MS, PRECIOUSNESS_FACTOR, type Preciousness } from "./types.ts";

/** A throwaway BATON_CONFIG_DIR scope. Never touches a real Baton dir. */
function scopeStore(name: string): Database {
  const root = mkdtempSync(join(tmpdir(), `baton-${name}-`));
  return openStore(ensurePaths(resolvePaths({ BATON_CONFIG_DIR: root })).dbPath);
}

const T0 = Date.parse("2026-08-24T12:00:00.000Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const NOW = at(0);

function addInstance(db: Database, app: string, name: string): void {
  db.query("INSERT INTO instances (app, name, env, created_at) VALUES (?, ?, ?, ?)").run(
    app,
    name,
    "{}",
    nowIso(),
  );
}

function setPreciousness(db: Database, app: string, instance: string, value: Preciousness): void {
  db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    preciousnessKey(app, instance),
    value,
  );
}

describe("setPool", () => {
  test("stores members in order and round-trips through getPool", () => {
    const db = scopeStore("pool-set");
    addInstance(db, "claude-code", "personal-2");

    expect(setPool(db, "claude-code", ["personal-2", "default"])).toEqual({
      app: "claude-code",
      members: ["personal-2", "default"],
    });
    expect(getPool(db, "claude-code")).toEqual({
      app: "claude-code",
      members: ["personal-2", "default"],
    });
    expect(getPool(db, "kimi")).toBeUndefined();
  });

  test("deduplicates while preserving first-seen order", () => {
    const db = scopeStore("pool-dedupe");
    addInstance(db, "claude-code", "a");
    expect(setPool(db, "claude-code", ["a", "default", "a"]).members).toEqual(["a", "default"]);
  });

  test("rejects an empty pool", () => {
    const db = scopeStore("pool-empty");
    expect(() => setPool(db, "claude-code", [])).toThrow("at least one member");
  });

  test("rejects members this scope has no instance definition for", () => {
    const db = scopeStore("pool-unknown");
    addInstance(db, "claude-code", "a");

    expect(() => setPool(db, "claude-code", ["a", "enterprise"])).toThrow(/'enterprise'/);
    // Instances are per app: another app's instance is not a member here.
    addInstance(db, "kimi", "work");
    expect(() => setPool(db, "claude-code", ["work"])).toThrow(/Unknown instance/);
    // ...and nothing was written by the rejected call.
    expect(getPool(db, "claude-code")).toBeUndefined();

    // 'default' always exists — it is the inherited environment as-is.
    expect(setPool(db, "claude-code", ["default"]).members).toEqual(["default"]);
  });

  test("rejects a pool for an app whose identity cannot be relocated", () => {
    const db = scopeStore("pool-no-identity");
    // opencode's credentials follow neither a config-dir var nor HOME, so two
    // 'instances' of it would be one account balancing against itself.
    expect(() => setPool(db, "opencode", ["default"])).toThrow(/no identity env var/);
    expect(getPool(db, "opencode")).toBeUndefined();
    // Apps that do have one are unaffected.
    expect(setPool(db, "kimi", ["default"]).members).toEqual(["default"]);
  });

  test("re-setting replaces the membership", () => {
    const db = scopeStore("pool-replace");
    addInstance(db, "claude-code", "a");
    addInstance(db, "claude-code", "b");
    setPool(db, "claude-code", ["a"]);
    setPool(db, "claude-code", ["b", "a"]);

    expect(getPool(db, "claude-code")!.members).toEqual(["b", "a"]);
    expect(listPools(db).length).toBe(1);
  });

  test("listPools is deterministic and clearPool removes exactly one app", () => {
    const db = scopeStore("pool-list");
    setPool(db, "kimi", ["default"]);
    setPool(db, "claude-code", ["default"]);

    expect(listPools(db)).toEqual([
      { app: "claude-code", members: ["default"] },
      { app: "kimi", members: ["default"] },
    ]);
    expect(clearPool(db, "kimi")).toBe(true);
    expect(clearPool(db, "kimi")).toBe(false);
    expect(listPools(db).map((p) => p.app)).toEqual(["claude-code"]);
  });
});

describe("removeFromPools", () => {
  test("drops the instance from the app's pool and clears an emptied one", () => {
    const db = scopeStore("pool-remove-member");
    addInstance(db, "claude-code", "a");
    addInstance(db, "claude-code", "b");
    addInstance(db, "kimi", "a");
    setPool(db, "claude-code", ["a", "b"]);
    setPool(db, "kimi", ["a"]);

    // Only the named app's pool is touched: instance names are per app.
    expect(removeFromPools(db, "claude-code", "a")).toEqual(["claude-code"]);
    expect(getPool(db, "claude-code")!.members).toEqual(["b"]);
    expect(getPool(db, "kimi")!.members).toEqual(["a"]);

    // The last member leaving clears the pool rather than leaving an empty one.
    expect(removeFromPools(db, "claude-code", "b")).toEqual(["claude-code"]);
    expect(getPool(db, "claude-code")).toBeUndefined();
    expect(removeFromPools(db, "claude-code", "b")).toEqual([]);
  });
});

describe("preciousnessFor", () => {
  test("defaults to burn and reads the per-instance setting", () => {
    const db = scopeStore("pool-precious");
    expect(preciousnessFor(db, "claude-code", "a")).toBe("burn");

    setPreciousness(db, "claude-code", "a", "conserve");
    expect(preciousnessFor(db, "claude-code", "a")).toBe("conserve");
    // Keyed per (app, instance): a sibling instance is unaffected.
    expect(preciousnessFor(db, "claude-code", "b")).toBe("burn");

    db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
      preciousnessKey("claude-code", "a"),
      "priceless",
    );
    expect(preciousnessFor(db, "claude-code", "a")).toBe("burn");
  });
});

describe("candidatesFor — precedence", () => {
  test("an explicit instance wins over the pool", () => {
    const db = scopeStore("cand-explicit");
    addInstance(db, "claude-code", "a");
    addInstance(db, "claude-code", "b");
    setPool(db, "claude-code", ["a", "b"]);

    expect(candidatesFor(db, "claude-code", "b", NOW).map((c) => c.instance)).toEqual(["b"]);
  });

  test("the pool balances when no instance is named, in configured order", () => {
    const db = scopeStore("cand-pool");
    addInstance(db, "claude-code", "a");
    addInstance(db, "claude-code", "b");
    setPool(db, "claude-code", ["b", "a", "default"]);

    expect(candidatesFor(db, "claude-code", undefined, NOW).map((c) => c.instance)).toEqual([
      "b",
      "a",
      "default",
    ]);
  });

  test("without a pool the only candidate is the inherited environment", () => {
    const db = scopeStore("cand-default");
    expect(candidatesFor(db, "claude-code", undefined, NOW)).toEqual([
      {
        instance: "default",
        defined: true,
        headroom: 1,
        preciousness: "burn",
        weight: 1,
        excludedUnlessLastResort: false,
      },
    ]);
  });
});

describe("candidatesFor — weighting", () => {
  test("weight is observed headroom scaled by preciousness", () => {
    const db = scopeStore("cand-weight");
    addInstance(db, "claude-code", "a");
    addInstance(db, "claude-code", "b");
    setPool(db, "claude-code", ["a", "b"]);
    setPreciousness(db, "claude-code", "b", "conserve");
    recordRun(db, "claude-code", "a", at(0));

    const [a, b] = candidatesFor(db, "claude-code", undefined, at(1000));
    expect(a!.headroom).toBeLessThan(1);
    expect(a!.weight).toBeCloseTo(a!.headroom * PRECIOUSNESS_FACTOR.burn, 12);
    expect(b!.weight).toBeCloseTo(PRECIOUSNESS_FACTOR.conserve, 12);
    // Conserving halves b's weight, so the busier-but-burnable a still leads.
    expect(a!.weight).toBeGreaterThan(b!.weight);
  });

  test("use spreads weight away from the busier member", () => {
    const db = scopeStore("cand-spread");
    addInstance(db, "claude-code", "a");
    addInstance(db, "claude-code", "b");
    setPool(db, "claude-code", ["a", "b"]);
    for (let i = 0; i < 5; i++) recordRun(db, "claude-code", "a", at(i * 1000));

    const [a, b] = candidatesFor(db, "claude-code", undefined, at(9000));
    expect(b!.weight).toBeGreaterThan(a!.weight);
    // Equal use ⇒ equal weight, and configured order is the tie-break.
    for (let i = 0; i < 5; i++) recordRun(db, "claude-code", "b", at(i * 1000));
    const tied = candidatesFor(db, "claude-code", undefined, at(9000));
    expect(tied[0]!.weight).toBe(tied[1]!.weight);
    expect(tied.map((c) => c.instance)).toEqual(["a", "b"]);
  });

  test("an emergency-only member keeps its factor but is flagged last resort", () => {
    const db = scopeStore("cand-emergency");
    addInstance(db, "claude-code", "spare");
    setPool(db, "claude-code", ["default", "spare"]);
    setPreciousness(db, "claude-code", "spare", "emergency");

    const [normal, spare] = candidatesFor(db, "claude-code", undefined, NOW);
    expect(normal!.excludedUnlessLastResort).toBe(false);
    expect(spare!.excludedUnlessLastResort).toBe(true);
    expect(spare!.preciousness).toBe("emergency");
    expect(spare!.headroom).toBe(1);
    expect(spare!.weight).toBeCloseTo(PRECIOUSNESS_FACTOR.emergency, 12);
  });

  test("a member with no instance definition is flagged undefined, not assumed", () => {
    const db = scopeStore("cand-dangling");
    addInstance(db, "claude-code", "a");
    setPool(db, "claude-code", ["a", "default"]);
    // What a removal that skipped the pool leaves behind.
    db.query("DELETE FROM instances WHERE app = ? AND name = ?").run("claude-code", "a");

    const [dangling, fallback] = candidatesFor(db, "claude-code", undefined, NOW);
    expect(dangling!.defined).toBe(false);
    expect(fallback!.defined).toBe(true);
  });

  test("a cooling member is annotated, not dropped — failover is the caller's call", () => {
    const db = scopeStore("cand-cooling");
    addInstance(db, "claude-code", "a");
    setPool(db, "claude-code", ["a", "default"]);
    recordAdmissionFailure(db, "claude-code", "a", at(0), "429");

    const during = candidatesFor(db, "claude-code", undefined, at(60_000));
    expect(during.map((c) => c.instance)).toEqual(["a", "default"]);
    expect(during[0]!.coolingUntil).toBe(at(COOLDOWN_BASE_MS));
    expect(during[1]!.coolingUntil).toBeUndefined();

    // Once the cooldown elapses the annotation disappears on its own.
    const after = candidatesFor(db, "claude-code", undefined, at(COOLDOWN_BASE_MS));
    expect(after[0]!.coolingUntil).toBeUndefined();
  });
});
