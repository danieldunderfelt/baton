import { Database, SQLiteError } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensurePaths, resolvePaths, type BatonPaths } from "../config/paths.ts";
import { newId, nowIso, openStore, pruneRuns, RUN_CAP, withBusyRetry } from "./store.ts";

/** A throwaway BATON_CONFIG_DIR scope. Never touches a real Baton dir. */
function scopePaths(name: string): BatonPaths {
  const root = mkdtempSync(join(tmpdir(), `baton-${name}-`));
  return ensurePaths(resolvePaths({ BATON_CONFIG_DIR: root }));
}

function scopeStore(name: string): { paths: BatonPaths; db: Database } {
  const paths = scopePaths(name);
  return { paths, db: openStore(paths.dbPath) };
}

const RUN_COLUMNS =
  "id, idempotency_key, model, app, slug, prompt, cwd, status, created_at, updated_at";
const RUN_PLACEHOLDERS = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?";

interface RunOverrides {
  id?: string;
  key?: string | null;
  status?: string;
  at?: string;
}

function insertRun(db: Database, overrides: RunOverrides = {}): string {
  const id = overrides.id ?? newId("run");
  const at = overrides.at ?? nowIso();
  db.query(`INSERT INTO runs (${RUN_COLUMNS}) VALUES (${RUN_PLACEHOLDERS})`).run(
    id,
    overrides.key ?? null,
    "kimi-k3",
    "kimi",
    "kimi-code/k3",
    "say hi",
    "/tmp",
    overrides.status ?? "queued",
    at,
    at,
  );
  return id;
}

const countRuns = (db: Database) =>
  db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n;

describe("openStore — connection pragmas", () => {
  test("WAL is actually on, not just requested", () => {
    const { paths, db } = scopeStore("wal");
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()!.journal_mode).toBe(
      "wal",
    );

    // WAL is a persistent file property: a naive connection sees it too.
    db.close();
    const raw = new Database(paths.dbPath, { strict: true });
    expect(raw.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()!.journal_mode).toBe(
      "wal",
    );
    raw.close();
  });

  test("busy_timeout and foreign_keys are set on the connection", () => {
    const { db } = scopeStore("pragmas");
    expect(db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()!.timeout).toBe(5000);
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()!.foreign_keys).toBe(
      1,
    );
  });

  test("creates the database file under the scope's data dir", () => {
    const { paths } = scopeStore("file");
    expect(existsSync(paths.dbPath)).toBe(true);
    expect(paths.dbPath.startsWith(paths.configDir)).toBe(true);
  });
});

describe("openStore — schema and migrations", () => {
  test("phase-1 tables exist", () => {
    const { db } = scopeStore("schema");
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);

    for (const t of ["runs", "attempts", "settings", "instances", "schema_migrations"]) {
      expect(tables).toContain(t);
    }
  });

  test("migrations apply exactly once and are idempotent across reopen", () => {
    const paths = scopePaths("migrate");

    const first = openStore(paths.dbPath);
    const applied = first
      .query<{ version: number; applied_at: string }, []>(
        "SELECT version, applied_at FROM schema_migrations ORDER BY version",
      )
      .all();
    expect(applied.length).toBeGreaterThan(0);
    expect(applied.map((r) => r.version)).toEqual(applied.map((_, i) => i + 1));
    insertRun(first, { id: "run_survivor" });
    first.close();

    // Reopening must not re-run migrations (that would throw "table already
    // exists") nor add rows, and must not disturb existing data.
    const second = openStore(paths.dbPath);
    const again = second
      .query<{ version: number; applied_at: string }, []>(
        "SELECT version, applied_at FROM schema_migrations ORDER BY version",
      )
      .all();
    expect(again).toEqual(applied);
    expect(countRuns(second)).toBe(1);

    const third = openStore(paths.dbPath);
    expect(
      third.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM schema_migrations").get()!.n,
    ).toBe(applied.length);
    second.close();
    third.close();
  });

  const runColumns = (db: Database) =>
    db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('runs')")
      .all()
      .map((r) => r.name);

  test("v2 adds runs.payload_hash for payload-bound idempotency", () => {
    const { db } = scopeStore("payload-hash");
    expect(runColumns(db)).toContain("payload_hash");
  });

  test("a database left at v1 is upgraded in place without losing data", () => {
    const paths = scopePaths("upgrade");
    const first = openStore(paths.dbPath);
    insertRun(first, { id: "run_pre_v2" });
    const versions =
      first.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM schema_migrations").get()!.n;
    // Rewind to a genuine v1 database: undo the later migrations' columns/tables.
    first.exec("ALTER TABLE attempts DROP COLUMN owner_pid");
    first.exec("ALTER TABLE runs DROP COLUMN payload_hash");
    for (const t of [
      "grades",
      "accumulator",
      "reliability",
      "priors",
      "quota_events",
      "cooldowns",
      "pools",
      "duels",
      "bt_edges",
      "discovered_adapters",
    ]) {
      first.exec(`DROP TABLE ${t}`);
    }
    first.query("DELETE FROM schema_migrations WHERE version > 1").run();
    first.close();

    const upgraded = openStore(paths.dbPath);
    expect(runColumns(upgraded)).toContain("payload_hash");
    expect(
      upgraded.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM schema_migrations").get()!.n,
    ).toBe(versions);
    expect(countRuns(upgraded)).toBe(1);
    upgraded.close();
  });
});

describe("openStore — concurrent fresh opens", () => {
  /**
   * Sol #2: migrate() used to read the schema version before taking any write
   * lock, so a fresh-open stampede had every process see version 0 and all but
   * one die on "table attempts already exists". Real subprocesses, one shared
   * fresh DB path, released together by a wall-clock barrier.
   */
  test("8 processes opening the same fresh database all succeed and migrate once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "baton-stampede-"));
    const dbPath = join(dir, "baton.db");
    const script = join(dir, "open.ts");
    writeFileSync(
      script,
      `import { openStore } from ${JSON.stringify(join(import.meta.dir, "store.ts"))};
       const [dbPath, startAt] = process.argv.slice(2);
       const wait = Number(startAt) - Date.now();
       if (wait > 0) Bun.sleepSync(wait);
       const db = openStore(dbPath!);
       db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(String(process.pid), "1");
       db.close();
      `,
    );

    const startAt = String(Date.now() + 1000);
    const procs = Array.from({ length: 8 }, () =>
      Bun.spawn(["bun", script, dbPath, startAt], { stdout: "pipe", stderr: "pipe" }),
    );
    const results = await Promise.all(
      procs.map(async (p) => ({ code: await p.exited, stderr: await new Response(p.stderr).text() })),
    );

    for (const r of results) {
      expect(r.stderr).not.toContain("already exists");
      expect(r.code).toBe(0);
    }

    const db = openStore(dbPath);
    const applied = db
      .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((r) => r.version);
    // Every migration recorded exactly once, no duplicates, no gaps.
    expect(applied).toEqual(applied.map((_, i) => i + 1));
    expect(new Set(applied).size).toBe(applied.length);
    // ...and all eight processes got a working database, not just the winner.
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM settings").get()!.n).toBe(8);
    db.close();
  }, 30_000);
});

describe("openStore — quota event retention", () => {
  /**
   * Retention has no background job: every process opens the store, so opening
   * is where observations no window can still see are dropped.
   */
  test("opening drops events older than the retention window and keeps the rest", () => {
    const paths = scopePaths("quota-retention");
    const first = openStore(paths.dbPath);
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    const insert = (at: string) =>
      first
        .query("INSERT INTO quota_events (app, instance, at, kind) VALUES ('kimi', 'a', ?, 'run')")
        .run(at);
    insert(ago(30 * 24 * 60 * 60 * 1000));
    insert(ago(2 * 60 * 60 * 1000));
    first.close();

    const reopened = openStore(paths.dbPath);
    const rows = reopened
      .query<{ at: string }, []>("SELECT at FROM quota_events ORDER BY at")
      .all();
    expect(rows).toHaveLength(1);
    expect(Date.now() - Date.parse(rows[0]!.at)).toBeLessThan(24 * 60 * 60 * 1000);
    reopened.close();
  });
});

describe("pruneRuns — capped ring buffer", () => {
  const stamp = (i: number) => new Date(1_700_000_000_000 + i * 1000).toISOString();

  function seedTerminal(db: Database, count: number, offset = 0): void {
    db.transaction(() => {
      for (let i = 0; i < count; i++) {
        const id = insertRun(db, { status: "succeeded", at: stamp(offset + i) });
        db.query("INSERT INTO attempts (id, run_id, seq, target) VALUES (?, ?, ?, ?)").run(
          newId("att"),
          id,
          1,
          "kimi:default/kimi-code/k3",
        );
      }
    })();
  }

  const countAttempts = (db: Database) =>
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM attempts").get()!.n;

  test("evicts the oldest terminal runs and their attempts down to the cap", () => {
    const { db } = scopeStore("prune");
    seedTerminal(db, RUN_CAP + 50);
    const oldest = db
      .query<{ id: string }, []>("SELECT id FROM runs ORDER BY created_at LIMIT 50")
      .all()
      .map((r) => r.id);

    expect(pruneRuns(db)).toBe(50);

    expect(countRuns(db)).toBe(RUN_CAP);
    expect(countAttempts(db)).toBe(RUN_CAP);
    for (const id of oldest) {
      expect(db.query("SELECT id FROM runs WHERE id = ?").get(id)).toBeFalsy();
      expect(db.query("SELECT id FROM attempts WHERE run_id = ?").get(id)).toBeFalsy();
    }
  });

  test("never evicts queued or running runs, even when they are the oldest", () => {
    const { db } = scopeStore("prune-live");
    insertRun(db, { id: "run_ancient_queued", status: "queued", at: stamp(0) });
    insertRun(db, { id: "run_ancient_running", status: "running", at: stamp(1) });
    seedTerminal(db, 20, 2);

    // 22 rows, cap 10 → 12 evictions, all of them terminal.
    expect(pruneRuns(db, 10)).toBe(12);

    const kept = db
      .query<{ id: string; status: string }, []>("SELECT id, status FROM runs ORDER BY created_at")
      .all();
    expect(kept.length).toBe(10);
    expect(kept.slice(0, 2).map((r) => r.id)).toEqual(["run_ancient_queued", "run_ancient_running"]);
  });

  test("is a no-op under the cap", () => {
    const { db } = scopeStore("prune-noop");
    seedTerminal(db, 5);
    expect(pruneRuns(db, 10)).toBe(0);
    expect(countRuns(db)).toBe(5);
    expect(countAttempts(db)).toBe(5);
  });

  test("openStore prunes on open, so the cap self-maintains across processes", () => {
    const paths = scopePaths("prune-open");
    const first = openStore(paths.dbPath);
    seedTerminal(first, 12);
    first.close();

    const second = openStore(paths.dbPath, 10);
    expect(countRuns(second)).toBe(10);
    second.close();
  });

  /**
   * A duel points at two runs, and those runs age out like any other. While
   * `duels.run_a/run_b` were foreign keys into runs(id), the first eviction of
   * a duelled run threw FOREIGN KEY constraint failed — inside openStore, so
   * every process in the scope stopped being able to open the database at all.
   */
  test("evicts runs that a duel points at, leaving the duel row void", () => {
    const paths = scopePaths("prune-duel");
    const db = openStore(paths.dbPath);
    seedTerminal(db, 12);
    const [a, b] = db
      .query<{ id: string }, []>("SELECT id FROM runs ORDER BY created_at LIMIT 2")
      .all()
      .map((r) => r.id) as [string, string];
    db.query(
      "INSERT INTO duels (id, model_a, model_b, run_a, run_b, label_map, created_at) VALUES (?,?,?,?,?,?,?)",
    ).run("duel_old", "kimi-k3", "opus-5", a, b, "{}", stamp(0));
    db.close();

    const reopened = openStore(paths.dbPath, 5);
    expect(countRuns(reopened)).toBe(5);
    // The verdict record survives its evidence; duelView reads it as void.
    expect(reopened.query("SELECT id FROM duels WHERE id = 'duel_old'").get()).toBeTruthy();
    expect(reopened.query("SELECT id FROM runs WHERE id = ?").get(a)).toBeFalsy();
    reopened.close();
  });
});

describe("runs table constraints", () => {
  test("idempotency_key is UNIQUE — a second insert with the same key conflicts", () => {
    const { db } = scopeStore("idem");
    insertRun(db, { key: "k-1" });

    let caught: unknown;
    try {
      insertRun(db, { key: "k-1" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SQLiteError);
    expect((caught as SQLiteError).code).toStartWith("SQLITE_CONSTRAINT");
    expect(String(caught)).toContain("runs.idempotency_key");
    expect(countRuns(db)).toBe(1);
  });

  test("runs without an idempotency key coexist (NULLs are not deduplicated)", () => {
    const { db } = scopeStore("idem-null");
    insertRun(db, { key: null });
    insertRun(db, { key: null });
    expect(countRuns(db)).toBe(2);
  });

  test("status CHECK rejects statuses outside the state machine", () => {
    const { db } = scopeStore("status");
    const id = insertRun(db);
    expect(db.query<{ status: string }, [string]>("SELECT status FROM runs WHERE id = ?").get(id)!.status).toBe(
      "queued",
    );
    expect(() => db.query("UPDATE runs SET status = ? WHERE id = ?").run("exploded", id)).toThrow();
    expect(() => db.query("UPDATE runs SET status = ? WHERE id = ?").run("timeout", id)).not.toThrow();
  });

  test("attempts reference a run and are unique per (run_id, seq)", () => {
    const { db } = scopeStore("attempts");
    const runId = insertRun(db);
    const insertAttempt = (rid: string, seq: number) =>
      db
        .query("INSERT INTO attempts (id, run_id, seq, target) VALUES (?, ?, ?, ?)")
        .run(newId("att"), rid, seq, "kimi:default/kimi-code/k3");

    insertAttempt(runId, 1);
    insertAttempt(runId, 2);
    expect(() => insertAttempt(runId, 1)).toThrow();
    expect(() => insertAttempt("run_does_not_exist", 1)).toThrow();
  });
});

describe("withBusyRetry", () => {
  /** A genuine bun:sqlite SQLITE_BUSY, so the predicate is tested against reality. */
  function realBusyError(): SQLiteError {
    const dir = mkdtempSync(join(tmpdir(), "baton-busyerr-"));
    const path = join(dir, "lock.db");
    const holder = openStore(path);
    const other = new Database(path, { strict: true });
    other.exec("PRAGMA busy_timeout = 0;");
    holder.exec("BEGIN IMMEDIATE");
    holder.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("a", "1");
    try {
      other.exec("BEGIN IMMEDIATE");
      throw new Error("expected the second connection to be blocked");
    } catch (err) {
      if (!(err instanceof SQLiteError)) throw err;
      return err;
    } finally {
      holder.exec("ROLLBACK");
      other.close();
      holder.close();
    }
  }

  test("a real locked-database error is recognised as busy and retried", () => {
    const busy = realBusyError();
    expect(busy.code).toBe("SQLITE_BUSY");

    let calls = 0;
    expect(() =>
      withBusyRetry(() => {
        calls++;
        throw busy;
      }, 3),
    ).toThrow(busy);
    expect(calls).toBe(3);
  });

  test("returns the value once the lock clears", () => {
    const busy = realBusyError();
    let calls = 0;
    const value = withBusyRetry(() => {
      calls++;
      if (calls < 3) throw busy;
      return "committed";
    }, 5);

    expect(value).toBe("committed");
    expect(calls).toBe(3);
  });

  test("rethrows non-busy errors immediately", () => {
    let calls = 0;
    expect(() =>
      withBusyRetry(() => {
        calls++;
        throw new Error("no such table: runs");
      }, 5),
    ).toThrow("no such table: runs");
    expect(calls).toBe(1);
  });

  test("wraps a real contended write and surfaces the busy error after its tries", () => {
    const dir = mkdtempSync(join(tmpdir(), "baton-busy-"));
    const path = join(dir, "baton.db");
    const holder = openStore(path);
    const contender = new Database(path, { strict: true });
    contender.exec("PRAGMA busy_timeout = 0;");
    holder.exec("BEGIN IMMEDIATE");
    holder.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("held", "1");

    let calls = 0;
    let thrown: unknown;
    try {
      withBusyRetry(() => {
        calls++;
        contender.exec("BEGIN IMMEDIATE");
      }, 2);
    } catch (err) {
      thrown = err;
    }

    expect(calls).toBe(2);
    expect((thrown as SQLiteError).code).toBe("SQLITE_BUSY");

    holder.exec("ROLLBACK");
    contender.close();
    holder.close();
  });
});

describe("id and time helpers", () => {
  test("newId is prefixed, opaque and unique", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId("run")));
    expect(ids.size).toBe(500);
    for (const id of ids) {
      expect(id).toStartWith("run_");
      expect(id.slice(4)).toMatch(/^[0-9a-z]+$/);
    }
    expect(newId("att")).toStartWith("att_");
  });

  test("nowIso is a UTC ISO-8601 timestamp that sorts chronologically", () => {
    const iso = nowIso();
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(iso).toISOString()).toBe(iso);
  });
});

/**
 * Phase-1 spike: "two scopes, two DBs, no bleed" (PLAN.md §Build phases).
 * This is the whole scope-separation mechanism — if it holds, cross-scope
 * leakage is structurally impossible without any runtime check.
 */
describe("BATON_CONFIG_DIR partitioning smoke", () => {
  test("two scopes get two databases with no cross-scope visibility", () => {
    const enterprise = scopeStore("scope-enterprise");
    const personal = scopeStore("scope-personal");

    // Distinct files, each rooted in its own scope.
    expect(enterprise.paths.dbPath).not.toBe(personal.paths.dbPath);
    expect(enterprise.paths.dbPath.startsWith(enterprise.paths.configDir + "/")).toBe(true);
    expect(personal.paths.dbPath.startsWith(personal.paths.configDir + "/")).toBe(true);
    expect(enterprise.paths.dbPath.startsWith(personal.paths.configDir)).toBe(false);
    expect(personal.paths.dbPath.startsWith(enterprise.paths.configDir)).toBe(false);
    expect(existsSync(enterprise.paths.dbPath)).toBe(true);
    expect(existsSync(personal.paths.dbPath)).toBe(true);

    // A run in the enterprise scope is invisible to the personal scope.
    insertRun(enterprise.db, { id: "run_enterprise", key: "shared-key" });
    expect(countRuns(enterprise.db)).toBe(1);
    expect(countRuns(personal.db)).toBe(0);

    // ...and the reverse. The same idempotency key is free in the other scope:
    // keys are scoped, so scopes cannot collide with or dedupe each other.
    insertRun(personal.db, { id: "run_personal", key: "shared-key" });
    insertRun(personal.db, { id: "run_personal_2", key: null });
    expect(countRuns(personal.db)).toBe(2);
    expect(countRuns(enterprise.db)).toBe(1);

    // Settings and instances partition the same way.
    enterprise.db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("max_hops", "1");
    personal.db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("max_hops", "9");
    enterprise.db
      .query("INSERT INTO instances (app, name, env, created_at) VALUES (?, ?, ?, ?)")
      .run("claude-code", "work", '{"CLAUDE_CONFIG_DIR":"/work/.claude"}', nowIso());

    const read = (db: Database, key: string) =>
      db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)
        ?.value;
    expect(read(enterprise.db, "max_hops")).toBe("1");
    expect(read(personal.db, "max_hops")).toBe("9");
    expect(
      personal.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM instances").get()!.n,
    ).toBe(0);

    enterprise.db.close();
    personal.db.close();

    // Reopening each scope from its own resolved paths keeps the split.
    const reopenedEnterprise = openStore(enterprise.paths.dbPath);
    const reopenedPersonal = openStore(personal.paths.dbPath);
    expect(
      reopenedEnterprise.query<{ id: string }, []>("SELECT id FROM runs").all().map((r) => r.id),
    ).toEqual(["run_enterprise"]);
    expect(
      reopenedPersonal
        .query<{ id: string }, []>("SELECT id FROM runs ORDER BY id")
        .all()
        .map((r) => r.id),
    ).toEqual(["run_personal", "run_personal_2"]);
    reopenedEnterprise.close();
    reopenedPersonal.close();
  });

  test("switching BATON_CONFIG_DIR switches databases for the same code path", () => {
    const rootA = mkdtempSync(join(tmpdir(), "baton-swapA-"));
    const rootB = mkdtempSync(join(tmpdir(), "baton-swapB-"));
    const open = (root: string) => {
      const paths = ensurePaths(resolvePaths({ BATON_CONFIG_DIR: root, HOME: "/home/tester" }));
      return { paths, db: openStore(paths.dbPath) };
    };

    const a = open(rootA);
    insertRun(a.db, { id: "run_a" });
    a.db.close();

    const b = open(rootB);
    expect(countRuns(b.db)).toBe(0);
    b.db.close();

    const aAgain = open(rootA);
    expect(countRuns(aAgain.db)).toBe(1);
    aAgain.db.close();

    expect(existsSync(join(rootB, "state", "baton.db"))).toBe(true);
    expect(a.paths.dbPath).toBe(join(rootA, "state", "baton.db"));
  });
});
