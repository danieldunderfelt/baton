import { Database } from "bun:sqlite";

// Retention policy for quota observations lives with the windows that define it;
// only the call site is here, next to the run ring buffer's, because open time is
// the one moment every process passes through.
import { pruneQuotaEvents } from "../quota/quota.ts";

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
  // v3 — phase 2: eval foundation (grades, decayed accumulator, priors),
  // quota observation, cooldowns, pools. PLAN.md §Evaluation, §Quota-aware cost.
  `
  CREATE TABLE grades (
    run_id    TEXT PRIMARY KEY REFERENCES runs(id),
    grade     REAL NOT NULL CHECK (grade >= 1 AND grade <= 5),
    notes     TEXT,
    category  TEXT NOT NULL DEFAULT '',
    target    TEXT NOT NULL,
    model     TEXT NOT NULL,
    run_at    TEXT NOT NULL,
    graded_at TEXT NOT NULL
  );

  CREATE TABLE accumulator (
    target   TEXT NOT NULL,
    model    TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    sum_wg   REAL NOT NULL DEFAULT 0,
    sum_w    REAL NOT NULL DEFAULT 0,
    sum_w2   REAL NOT NULL DEFAULT 0,
    n        INTEGER NOT NULL DEFAULT 0,
    as_of    TEXT NOT NULL,
    PRIMARY KEY (target, category)
  );

  CREATE TABLE reliability (
    target     TEXT PRIMARY KEY,
    sum_w_ok   REAL NOT NULL DEFAULT 0,
    sum_w_fail REAL NOT NULL DEFAULT 0,
    as_of      TEXT NOT NULL
  );

  CREATE TABLE priors (
    profile  TEXT NOT NULL,
    model    TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    mean     REAL NOT NULL CHECK (mean >= 1 AND mean <= 5),
    weight   REAL NOT NULL,
    source   TEXT NOT NULL,
    as_of    TEXT NOT NULL,
    PRIMARY KEY (profile, model, category)
  );

  CREATE TABLE quota_events (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    app      TEXT NOT NULL,
    instance TEXT NOT NULL,
    at       TEXT NOT NULL,
    kind     TEXT NOT NULL CHECK (kind IN ('run','admission_failure','usage')),
    tokens   INTEGER,
    detail   TEXT
  );
  CREATE INDEX idx_quota_events_key ON quota_events(app, instance, at);

  CREATE TABLE cooldowns (
    app      TEXT NOT NULL,
    instance TEXT NOT NULL,
    until    TEXT NOT NULL,
    strikes  INTEGER NOT NULL DEFAULT 1,
    reason   TEXT,
    PRIMARY KEY (app, instance)
  );

  CREATE TABLE pools (
    app        TEXT PRIMARY KEY,
    members    TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // v4 — multi-process ownership: several Baton processes legitimately share a
  // scope (a CLI run + a callee's own MCP server), so orphan recovery must know
  // which process owns an in-flight attempt before declaring it abandoned.
  `ALTER TABLE attempts ADD COLUMN owner_pid INTEGER;`,
  // v5 — phase 3: blind duels + decayed Bradley-Terry edge map, and the
  // quarantine store for agentically discovered adapters (PLAN.md §Agentic
  // discovery: approval precedes execution).
  `
  CREATE TABLE duels (
    id          TEXT PRIMARY KEY,
    category    TEXT NOT NULL DEFAULT '',
    model_a     TEXT NOT NULL,
    model_b     TEXT NOT NULL,
    run_a       TEXT NOT NULL REFERENCES runs(id),
    run_b       TEXT NOT NULL REFERENCES runs(id),
    label_map   TEXT NOT NULL,
    winner      TEXT CHECK (winner IN ('A','B','tie')),
    created_at  TEXT NOT NULL,
    reported_at TEXT
  );

  CREATE TABLE bt_edges (
    model_a  TEXT NOT NULL,
    model_b  TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    wins_a   REAL NOT NULL DEFAULT 0,
    wins_b   REAL NOT NULL DEFAULT 0,
    ties     REAL NOT NULL DEFAULT 0,
    as_of    TEXT NOT NULL,
    PRIMARY KEY (model_a, model_b, category),
    CHECK (model_a < model_b)
  );

  CREATE TABLE discovered_adapters (
    app            TEXT PRIMARY KEY,
    spec           TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'quarantined'
                   CHECK (status IN ('quarantined','approved','active','stale','rejected')),
    submitted_at   TEXT NOT NULL,
    reviewed_at    TEXT,
    binary_version TEXT,
    notes          TEXT
  );
  `,
  // v6 — the duel rows outlive the runs they point at. The ring buffer evicts
  // runs by age (PLAN.md §Evaluation), and a foreign key to runs(id) turned
  // that eviction into "FOREIGN KEY constraint failed" inside openStore, i.e.
  // every process in the scope failing to open the database. A duel whose runs
  // are gone is void, not judgeable — which is what duelView already reports —
  // so the reference is advisory and the constraint has to go.
  `
  CREATE TABLE duels_v6 (
    id          TEXT PRIMARY KEY,
    category    TEXT NOT NULL DEFAULT '',
    model_a     TEXT NOT NULL,
    model_b     TEXT NOT NULL,
    run_a       TEXT NOT NULL,
    run_b       TEXT NOT NULL,
    label_map   TEXT NOT NULL,
    winner      TEXT CHECK (winner IN ('A','B','tie')),
    created_at  TEXT NOT NULL,
    reported_at TEXT
  );
  INSERT INTO duels_v6 SELECT * FROM duels;
  DROP TABLE duels;
  ALTER TABLE duels_v6 RENAME TO duels;
  `,
  // v7 — Σw² per duel edge, the same sufficient statistic the accumulator keeps
  // (PLAN.md §Decay: "Σw² decays by the square"). Without it nEff on the BT side
  // was the raw decayed mass, which calls ten half-faded duels one observation.
  // Existing edges start at 0 and therefore report nEff 0 until they are judged
  // again; they are days old and decay, so no backfill is attempted (a backfill
  // would have to invent the event weights that are exactly what was not kept).
  `ALTER TABLE bt_edges ADD COLUMN mass2 REAL NOT NULL DEFAULT 0;`,
  // v8 — the user-owned route deny list (PLAN.md §Registry: route blocks).
  // Baton cannot tell whose subscription a route spends, so the user can name
  // the ones it must never spend; written only through the trusted CLI, like
  // the authority ceiling.
  `
  CREATE TABLE route_blocks (
    pattern    TEXT PRIMARY KEY,
    reason     TEXT,
    created_at TEXT NOT NULL
  );
  `,
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
  // Every Baton process opens the store, so retention self-maintains without a
  // background job: the run ring buffer (PLAN.md §Evaluation) and the quota
  // observations no window can still see (PLAN.md §Quota-aware cost).
  pruneRuns(db, cap);
  withBusyRetry(() => pruneQuotaEvents(db, nowIso()));
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
