import { Database } from "bun:sqlite";

/**
 * SQLite is the source of truth for everything mutable (PLAN.md §Architecture).
 * WAL + busy_timeout + retry-on-BUSY; serialized, versioned migrations.
 * One DB per scope — the path comes from resolvePaths(), never hardcoded.
 */

const MIGRATIONS: string[] = [
  // v1 — phase-1 schema: runs, attempts, settings, instances.
  `
  CREATE TABLE runs (
    id              TEXT PRIMARY KEY,
    idempotency_key TEXT UNIQUE,
    model           TEXT NOT NULL,
    app             TEXT NOT NULL,
    slug            TEXT NOT NULL,
    instance        TEXT NOT NULL DEFAULT 'default',
    prompt          TEXT NOT NULL,
    cwd             TEXT NOT NULL,
    category        TEXT,
    options         TEXT NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','running','succeeded','failed','timeout','cancelled','orphaned')),
    policy_version  INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );

  CREATE TABLE attempts (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES runs(id),
    seq         INTEGER NOT NULL,
    target      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','succeeded','failed','timeout','cancelled','orphaned')),
    pid         INTEGER,
    started_at  TEXT,
    finished_at TEXT,
    exit_code   INTEGER,
    output      TEXT,
    raw_tail    TEXT,
    error       TEXT,
    session_ref TEXT,
    UNIQUE (run_id, seq)
  );
  CREATE INDEX idx_attempts_run ON attempts(run_id);
  CREATE INDEX idx_attempts_status ON attempts(status);

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE instances (
    app        TEXT NOT NULL,
    name       TEXT NOT NULL,
    env        TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    PRIMARY KEY (app, name)
  );
  `,
  // v2 — payload-bound idempotency: the hash of the request an idempotency_key
  // was minted for, so a reused key with a different payload can be rejected.
  `ALTER TABLE runs ADD COLUMN payload_hash TEXT;`,
];

/** Ring-buffer cap on retained runs (PLAN.md §Evaluation: ~2,000 runs). */
export const RUN_CAP = 2000;

export function openStore(dbPath: string, cap = RUN_CAP): Database {
  const db = new Database(dbPath, { create: true, strict: true });
  // Enabling WAL takes the write lock, so a fresh-open stampede can hit BUSY here too.
  withBusyRetry(() => db.exec("PRAGMA journal_mode = WAL;"), MIGRATION_TRIES);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  // Every Baton process opens the store, so the ring buffer self-maintains
  // without a background job (PLAN.md §Evaluation: capped run ring buffer).
  pruneRuns(db, cap);
  return db;
}

const MIGRATION_TRIES = 25;

/**
 * The whole pass runs inside one BEGIN IMMEDIATE: the write lock is taken
 * *before* the applied versions are read, so concurrent fresh opens serialize
 * instead of both seeing version 0 and racing to CREATE the same tables.
 */
function migrate(db: Database): void {
  withBusyRetry(
    () =>
      inImmediate(db, () => {
        db.exec(
          "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
        );
        const current =
          db
            .query<{ v: number }, []>("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations")
            .get()?.v ?? 0;
        for (let i = current; i < MIGRATIONS.length; i++) {
          db.exec(MIGRATIONS[i]!);
          db.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
            i + 1,
            nowIso(),
          );
        }
      }),
    MIGRATION_TRIES,
  );
}

/**
 * Trims the run ring buffer to `cap`, oldest first. Only terminal runs are
 * evictable — queued/running rows are live state and survive regardless of age.
 * Attempts go first so the runs FK never dangles. Returns the runs deleted.
 */
export function pruneRuns(db: Database, cap = RUN_CAP): number {
  if (countRuns(db) <= cap) return 0;
  return withBusyRetry(() =>
    inImmediate(db, () => {
      const excess = countRuns(db) - cap;
      if (excess <= 0) return 0;
      const victims = `SELECT id FROM runs WHERE status NOT IN ('queued','running')
                       ORDER BY created_at, rowid LIMIT ?`;
      db.query(`DELETE FROM attempts WHERE run_id IN (${victims})`).run(excess);
      return db.query(`DELETE FROM runs WHERE id IN (${victims})`).run(excess).changes;
    }),
  );
}

function countRuns(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()?.n ?? 0;
}

/** BEGIN IMMEDIATE ... COMMIT, rolling back on failure. Busy-on-BEGIN never rolls back. */
function inImmediate<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back by SQLite; the original error is what matters.
    }
    throw err;
  }
}

/** Retry a synchronous DB operation on SQLITE_BUSY with linear backoff. */
export function withBusyRetry<T>(fn: () => T, tries = 5): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isBusy(err) || attempt >= tries) throw err;
      Bun.sleepSync(50 * attempt);
    }
  }
}

/**
 * bun:sqlite reports contention as `code: "SQLITE_BUSY"` with the message
 * "database is locked" — the code is the only reliable signal. SQLITE_LOCKED
 * (shared-cache/table lock) is retryable on the same terms.
 */
function isBusy(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code === "SQLITE_LOCKED");
}

export function newId(prefix: string): string {
  const rand = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
