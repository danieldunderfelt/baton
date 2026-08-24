import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { builtinAdapters, getAdapter } from "../adapters/builtin/index.ts";
import { killProcessGroup } from "../adapters/executor.ts";
import { AUTONOMY_ORDER, type Autonomy } from "../adapters/types.ts";
import { ensurePaths, resolvePaths, type BatonPaths } from "../config/paths.ts";
import {
  recordGrade,
  setActiveProfile,
  setRatingSetting,
  type PriorDiff,
  type PriorRef,
} from "../eval/evalStore.ts";
import {
  diffProfileDocument,
  importProfileFile,
  parseProfileDocument,
} from "../eval/profileFile.ts";
import { publishRatings, repairProjection, snapshotRatings } from "../eval/publish.ts";
import {
  SETTING_ACTIVE_PROFILE,
  SETTING_HALF_LIFE_DAYS,
  SETTING_PROFILE_WEIGHT,
} from "../eval/types.ts";
import {
  candidatesFor,
  clearPool,
  getPool,
  listPools,
  preciousnessKey,
  removeFromPools,
  setPool,
} from "../quota/pools.ts";
import { PRECIOUSNESS_FACTOR, SETTING_PRECIOUSNESS_PREFIX } from "../quota/types.ts";
import { detectApps, listModels } from "../registry/registry.ts";
import { nowIso, openStore, withBusyRetry } from "../store/store.ts";
import { createSupervisor } from "../supervisor/supervisor.ts";
import {
  HOPS_ENV,
  SETTING_MAX_AUTONOMY_PREFIX,
  SETTING_MAX_CONCURRENT,
  SETTING_MAX_HOPS,
  type RunStatus,
} from "../supervisor/types.ts";
import { INSTALL_HOSTS, installHost, isInstallHost } from "./install.ts";

/**
 * The trusted face of Baton: the only place the authority ceiling and instance
 * definitions can be written (never through a tool call — PLAN.md §Execution).
 * Everything reads and writes the scope resolved from BATON_CONFIG_DIR.
 */

/**
 * Identity vars printed by `status`: the env overlays that actually move an
 * app's credentials. Deliberately wider than the registry (status reports the
 * environment the user is standing in), but not wider than the truth — opencode
 * is absent because it has no such var, so printing one would invite a scope
 * separation that does not exist.
 */
const IDENTITY_ENV = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "KIMI_CODE_HOME"] as const;

const RUNS_LIMIT = 20;
const PROMPT_PREVIEW_CHARS = 60;

export async function runCli(command: string, args: string[]): Promise<number> {
  try {
    switch (command) {
      case "status":
        return status();
      case "detect":
        return detect();
      case "models":
        return models();
      case "run":
        return await run(args);
      case "runs":
        return runs(args);
      case "instance":
        return instance(args);
      case "pool":
        return pool(args);
      case "ratings":
        return ratings(args);
      case "profile":
        return profile(args);
      case "grade":
        return grade(args);
      case "set":
        return set(args);
      case "install":
        return install(args);
      default:
        return usage(`unknown command '${command}'`);
    }
  } catch (err) {
    if (err instanceof UsageError) return usage(err.message);
    console.error(`baton: ${message(err)}`);
    return 1;
  }
}

/** Bad invocation (exit 2), as opposed to a failure while doing the work (1). */
class UsageError extends Error {}

function status(): number {
  const env = process.env;
  const paths = resolvePaths(env);
  const rows: string[][] = [
    ["scope", paths.scoped ? `${env.BATON_CONFIG_DIR} (BATON_CONFIG_DIR)` : "default (XDG)"],
    ["configDir", paths.configDir],
    ["dbPath", paths.dbPath],
    ["hops", `${hopDepth(env)} (${HOPS_ENV}=${env[HOPS_ENV] ?? "unset"})`],
  ];
  for (const key of IDENTITY_ENV) rows.push([key, env[key] ?? "(unset)"]);
  console.log(table(rows));

  console.log("\nadapters:");
  for (const app of detectApps({ probeVersion: false })) {
    console.log(`  ${app.app.padEnd(12)} ${app.binaryPath ?? "not on PATH in this scope"}`);
  }
  return 0;
}

function detect(): number {
  const modelsByApp = new Map(
    builtinAdapters.map((spec) => [spec.app, spec.models.map((m) => m.model).join(", ")]),
  );
  const rows: string[][] = [["APP", "BINARY", "VERSION", "MODELS"]];
  for (const app of detectApps()) {
    rows.push([
      app.app,
      app.binaryPath ?? "(not found)",
      app.version ?? "-",
      modelsByApp.get(app.app) ?? "-",
    ]);
  }
  console.log(table(rows));
  return 0;
}

function models(): number {
  const db = openDb();
  const rows: string[][] = [["MODEL", "ROUTE", "AVAILABLE", "MAX AUTONOMY"]];
  for (const m of listModels(db)) {
    rows.push([m.model, `${m.app}/${m.slug}`, m.available ? "yes" : "no", m.maxAutonomy]);
  }
  console.log(table(rows));
  return 0;
}

async function run(args: string[]): Promise<number> {
  const { flags, rest } = parseFlags(args, {
    value: ["cwd", "timeout", "autonomy", "instance"],
  });
  const model = rest[0];
  if (!model) return usage("run needs a model: baton run <model> <prompt...>");

  const prompt = await readPrompt(rest.slice(1));
  if (!prompt) return usage("run needs a prompt (or '-' to read one from stdin)");

  const autonomy = flags.autonomy === undefined ? undefined : parseAutonomy(String(flags.autonomy));
  const timeoutMs =
    flags.timeout === undefined ? undefined : parsePositiveInt(String(flags.timeout), "--timeout");

  const db = openDb();
  const supervisor = createSupervisor({ db, env: { ...process.env }, hostCwd: process.cwd() });
  const { view, settled } = await supervisor.startRun({
    model,
    prompt,
    ...(flags.cwd === undefined ? {} : { cwd: resolve(String(flags.cwd)) }),
    ...(flags.instance === undefined ? {} : { instance: String(flags.instance) }),
    options: {
      ...(autonomy ? { autonomy } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    },
  });

  // Ctrl-C must not leave the callee's process group running: the CLI is its
  // only supervisor, and cancelRun merely SIGTERMs (its SIGKILL escalation is an
  // unref'd timer that an exiting process never fires). Cancel, wait for the
  // group to be verifiably dead, then leave with the signal's exit code.
  let cancelling = false;
  const cancel = async (exitCode: number): Promise<void> => {
    if (cancelling) return; // a second Ctrl-C while the group is dying changes nothing
    cancelling = true;
    supervisor.cancelRun(view.runId);
    const kills = attemptPids(db, view.runId).map((pid) => killProcessGroup(pid));
    for (const outcome of await Promise.all(kills)) {
      if (!outcome.dead) console.error(`baton: ${outcome.why}`);
    }
    console.error(`baton: run ${view.runId} cancelled`);
    process.exit(exitCode);
  };
  const sigint = (): void => void cancel(130);
  const sigterm = (): void => void cancel(143);
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);

  // There is no --no-wait: this process is the supervisor, so detaching would
  // orphan the record. Async delegation is the MCP server's job (wait:false),
  // because that server outlives the call.
  try {
    await settled;
  } finally {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
  }
  const final = supervisor.getRun(view.runId) ?? view;
  if (final.status === "succeeded") {
    console.log(final.output ?? "");
    return 0;
  }
  console.error(`baton: run ${final.runId} ${final.status}: ${final.error ?? "no error recorded"}`);
  return 1;
}

/** Process groups this run launched — everything the CLI is allowed to kill. */
function attemptPids(db: Database, runId: string): number[] {
  return db
    .query<{ pid: number | null }, [string]>("SELECT pid FROM attempts WHERE run_id = ?")
    .all(runId)
    .map((row) => row.pid)
    .filter((pid): pid is number => pid !== null && pid > 0);
}

function runs(args: string[]): number {
  const db = openDb();
  const runId = args[0];
  if (!runId) return runList(db);

  const row = db
    .query<RunDetailRow, [string]>(
      "SELECT id, model, app, slug, instance, status, cwd, category, prompt, created_at, updated_at FROM runs WHERE id = ?",
    )
    .get(runId);
  if (!row) {
    console.error(`baton: unknown run '${runId}'. 'baton runs' lists the most recent ones.`);
    return 1;
  }

  console.log(
    table([
      ["run", row.id],
      ["model", `${row.model} via ${row.app}:${row.instance}/${row.slug}`],
      ["status", row.status],
      ["cwd", row.cwd],
      ["category", row.category ?? "-"],
      ["created", row.created_at],
      ["updated", row.updated_at],
    ]),
  );

  const attempts = db
    .query<AttemptDetailRow, [string]>(
      "SELECT seq, target, status, exit_code, error, output, started_at, finished_at FROM attempts WHERE run_id = ? ORDER BY seq",
    )
    .all(runId);
  console.log("\nattempts:");
  for (const a of attempts) {
    console.log(`  #${a.seq} ${a.target}`);
    console.log(
      `     ${a.status}  exit=${a.exit_code ?? "-"}  started=${a.started_at ?? "-"}  finished=${a.finished_at ?? "-"}`,
    );
    if (a.error) console.log(`     error: ${a.error}`);
  }

  console.log(`\nprompt:\n${indent(row.prompt)}`);
  const output = attempts.findLast((a) => a.output)?.output;
  if (output) console.log(`\noutput:\n${indent(output)}`);
  return 0;
}

function runList(db: Database): number {
  const rows = db
    .query<RunListRow, [number]>(
      "SELECT id, model, status, created_at, prompt FROM runs ORDER BY created_at DESC, id DESC LIMIT ?",
    )
    .all(RUNS_LIMIT);
  if (rows.length === 0) {
    console.log("No runs in this scope yet.");
    return 0;
  }
  const table_: string[][] = [["ID", "MODEL", "STATUS", "AGE", "PROMPT"]];
  for (const r of rows) {
    table_.push([r.id, r.model, r.status, age(r.created_at), preview(r.prompt)]);
  }
  console.log(table(table_));
  return 0;
}

function instance(args: string[]): number {
  const sub = args[0];
  switch (sub) {
    case "add":
      return instanceAdd(args.slice(1));
    case "list":
      return instanceList();
    case "remove":
      return instanceRemove(args.slice(1));
    default:
      return usage("instance takes: add <app> <name> --env KEY=VAL | list | remove <app> <name>");
  }
}

function instanceAdd(args: string[]): number {
  const { flags, rest } = parseFlags(args, { value: [], repeat: ["env"] });
  const [app, name] = rest;
  if (!app || !name) return usage("instance add needs: <app> <name> [--env KEY=VAL ...]");
  const spec = getAdapter(app);
  if (!spec) return usage(`unknown app '${app}'. Known apps: ${knownApps().join(", ")}.`);
  if (name === "default") {
    return usage("'default' is the inherited environment and cannot be redefined.");
  }
  // An app whose identity cannot be relocated by an env var has exactly one
  // account, whatever we name it (PLAN.md §Instance mechanics: opencode's
  // credentials follow neither a config-dir var nor HOME).
  const identityEnv = spec.identityEnv;
  if (!identityEnv) {
    return usage(
      `'${app}' has no identity env var, so a second instance would be the same account under another name. Instances and pools are not supported for it; its only instance is 'default' (the inherited environment).`,
    );
  }

  const env: Record<string, string> = {};
  for (const entry of asList(flags.env)) {
    const eq = entry.indexOf("=");
    const key = eq > 0 ? entry.slice(0, eq) : "";
    if (!key) return usage(`--env expects KEY=VALUE, got '${entry}'`);
    env[key] = expandHome(entry.slice(eq + 1));
  }
  if (!env[identityEnv]) {
    return usage(
      `instance add ${app} ${name} must set ${identityEnv} (e.g. --env ${identityEnv}=~/.${app}-${name}): an overlay that does not relocate ${app}'s identity is a second name for the same account.`,
    );
  }

  const db = openDb();
  withBusyRetry(() =>
    db
      .query(
        `INSERT INTO instances (app, name, env, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (app, name) DO UPDATE SET env = excluded.env`,
      )
      .run(app, name, JSON.stringify(env), nowIso()),
  );

  const assignments = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(`Added instance ${app}:${name} (${assignments})`);
  console.log(`Log in once, interactively: ${assignments} ${spec.binary}`);
  return 0;
}

/**
 * The callee inherits an instance's env values verbatim, and no CLI expands `~`
 * itself — a stored '~/.claude-personal2' would be read as a *relative* path and
 * silently create './~/.claude-personal2' in the checkout, i.e. the wrong
 * identity. Expand at write time so 'instance list' shows what will actually run.
 */
function expandHome(value: string): string {
  const home = process.env.HOME ?? homedir();
  if (value === "~") return home;
  return value.startsWith("~/") ? join(home, value.slice(2)) : value;
}

function instanceList(): number {
  const db = openDb();
  const rows = db
    .query<{ app: string; name: string; env: string; created_at: string }, []>(
      "SELECT app, name, env, created_at FROM instances ORDER BY app, name",
    )
    .all();
  if (rows.length === 0) {
    console.log("No instances defined in this scope (every app has an implicit 'default').");
    return 0;
  }
  const out: string[][] = [["APP", "NAME", "ENV"]];
  for (const r of rows) out.push([r.app, r.name, envSummary(r.env)]);
  console.log(table(out));
  return 0;
}

function instanceRemove(args: string[]): number {
  const [app, name] = args;
  if (!app || !name) return usage("instance remove needs: <app> <name>");
  const db = openDb();
  // Removing the definition without removing the pool references leaves behind
  // a member selection can only refuse; one transaction, so it cannot
  // half-happen.
  const removed = withBusyRetry(() =>
    db.transaction(() => {
      const changes = db
        .query("DELETE FROM instances WHERE app = ? AND name = ?")
        .run(app, name).changes;
      return { changes, pools: changes > 0 ? removeFromPools(db, app, name) : [] };
    })(),
  );
  if (removed.changes === 0) {
    console.error(`baton: no instance ${app}:${name} in this scope.`);
    return 1;
  }
  console.log(`Removed instance ${app}:${name}`);
  for (const poolApp of removed.pools) {
    const members = getPool(db, poolApp)?.members;
    console.error(
      `baton: warning: also removed '${name}' from the ${poolApp} pool (now: ${members?.join(", ") ?? "no pool — selection falls back to 'default'"}).`,
    );
  }
  return 0;
}

/**
 * Pools are user-defined config, trusted like the rest of the environment
 * (PLAN.md §Instance pools) — which is exactly why they are set here and not
 * through a tool call.
 */
function pool(args: string[]): number {
  const sub = args[0];
  switch (sub) {
    case "set":
      return poolSet(args.slice(1));
    case "list":
      return poolList();
    case "clear":
      return poolClear(args.slice(1));
    default:
      return usage("pool takes: set <app> <instance...> | list | clear <app>");
  }
}

function poolSet(args: string[]): number {
  const [app, ...members] = args;
  if (!app || members.length === 0) {
    return usage("pool set needs: <app> <instance...> (use 'default' for the inherited env)");
  }
  requireKnownApp(app);
  const db = openDb();
  const saved = withBusyRetry(() => setPool(db, app, members));
  console.log(`Pool ${app}: ${saved.members.join(", ")}`);
  return 0;
}

/** Members with what selection actually ranks them on, in tie-break order. */
function poolList(): number {
  const db = openDb();
  const pools = listPools(db);
  if (pools.length === 0) {
    console.log("No pools defined in this scope. 'baton pool set <app> <instance...>' defines one.");
    return 0;
  }
  const now = nowIso();
  const rows: string[][] = [["APP", "INSTANCE", "PRECIOUSNESS", "HEADROOM", "COOLING UNTIL"]];
  for (const p of pools) {
    for (const c of candidatesFor(db, p.app, undefined, now)) {
      rows.push([p.app, c.instance, c.preciousness, fixed(c.headroom), c.coolingUntil ?? "-"]);
    }
  }
  console.log(table(rows));
  return 0;
}

function poolClear(args: string[]): number {
  const app = args[0];
  if (!app) return usage("pool clear needs: <app>");
  const db = openDb();
  if (!withBusyRetry(() => clearPool(db, app))) {
    console.error(`baton: no pool for app '${app}' in this scope.`);
    return 1;
  }
  console.log(`Cleared pool for ${app} (selection falls back to 'default').`);
  return 0;
}

/**
 * The ratings view: observed, prior and blended stay three visibly separate
 * numbers, because the whole point of the provenance split is that the user can
 * see which one is carrying a routing decision (PLAN.md §Evaluation).
 */
function ratings(args: string[]): number {
  const sub = args[0];
  if (sub === "publish") return ratingsPublish();
  if (sub !== undefined) return usage("ratings takes: (nothing) | publish");

  const db = openDb();
  const snap = snapshotRatings(db);
  console.log(
    table([
      ["profile", snap.profile ?? "(none)"],
      ["profile weight", fixed(snap.profileWeight)],
      ["revision", String(snap.revision)],
    ]),
  );
  if (snap.rows.length === 0) {
    console.log(
      "\nNo ratings yet: grade a run with 'baton grade <run-id> <1-5>', or seed priors via the seed_ratings tool.",
    );
    return 0;
  }
  const rows: string[][] = [["MODEL", "CATEGORY", "OBSERVED (nEff)", "PRIOR (SOURCE)", "BLENDED"]];
  for (const r of snap.rows) {
    rows.push([
      r.model,
      r.category || "-",
      r.observed === null ? "-" : `${fixed(r.observed)} (${fixed(r.nEff)})`,
      r.prior === null ? "-" : `${fixed(r.prior)} (${r.priorSource ?? "?"})`,
      r.blended === null ? "-" : fixed(r.blended),
    ]);
  }
  console.log(`\n${table(rows)}`);
  return 0;
}

function ratingsPublish(): number {
  const { db, paths } = openScope();
  const res = repairProjection(db, paths.configDir);
  console.log(
    res.published
      ? `Published ${res.path} at revision ${res.revision}`
      : `${res.path} is already at revision ${res.revision}`,
  );
  return 0;
}

function profile(args: string[]): number {
  if (args[0] === "import") return profileImport(args.slice(1));
  return usage("profile takes: import <file> [--name <n>] [--activate] [--yes]");
}

/**
 * Import shows a summary diff and never silently reweights (PLAN.md §Layering).
 * There is no interactive prompt — the caller is usually an agent — so the diff
 * is the dry run and `--yes` is the commit.
 */
function profileImport(args: string[]): number {
  const { flags, rest } = parseFlags(args, { value: ["name"], boolean: ["activate", "yes"] });
  const file = rest[0];
  if (!file) return usage("profile import needs: <file> [--name <n>] [--activate] [--yes]");
  const path = resolve(file);
  const doc = parseProfileDocument(read(path), path);
  const target = flags.name === undefined ? doc.name : String(flags.name);
  const activate = flags.activate === true;
  const { db, paths } = openScope();

  if (flags.yes !== true) {
    printDiff(doc.name, target, diffProfileDocument(db, doc, target));
    console.log(
      `\nNothing was written. Re-run with --yes to commit${activate ? " and activate" : ""}.`,
    );
    return 0;
  }

  const diff = importProfileFile(db, path, { name: target, activate });
  printDiff(diff.source, target, diff);
  publishRatings(db, paths.configDir);
  console.log(`\nImported into profile '${target}' at revision ${diff.revision}.`);
  console.log(
    activate
      ? `Active profile is now '${target}'.`
      : `Not activated: 'baton set ${SETTING_ACTIVE_PROFILE} ${target}' switches to it.`,
  );
  return 0;
}

function printDiff(source: string, target: string, diff: PriorDiff): void {
  console.log(`Profile '${source}' → local profile '${target}'`);
  for (const e of diff.added) console.log(`  + ${priorLabel(e)}`);
  for (const c of diff.changed) {
    // as_of is part of what changes: a prior decays from it, so a re-import
    // with the same numbers but a fresher date really does reweight the prior.
    // Without the date shown, such a row reads as "changed: 4 → 4".
    console.log(
      `  ~ ${priorLabel(c)} (was mean ${fixed(c.previous.mean)} weight ${fixed(c.previous.weight)} as_of ${day(c.previous.asOf)}, ${c.previous.source})`,
    );
  }
  for (const e of diff.unchanged) console.log(`  = ${priorLabel(e)}`);
  console.log(
    `${diff.added.length} added, ${diff.changed.length} changed, ${diff.unchanged.length} unchanged`,
  );
}

/** An ISO instant as its calendar day — priors age in days, not seconds. */
function day(iso: string): string {
  return iso.slice(0, 10);
}

function priorLabel(e: PriorRef): string {
  return `${e.model}${e.category ? ` [${e.category}]` : ""} mean ${fixed(e.mean)} weight ${fixed(e.weight)}`;
}

/**
 * `report_result` from the shell. Grades are consumer grades on the answer, so
 * they attach to the attempt that produced one; a run that never produced an
 * answer is a reliability event, which the supervisor already recorded.
 */
function grade(args: string[]): number {
  const [runId, value, ...notes] = args;
  if (!runId || value === undefined) return usage("grade needs: <run-id> <1-5> [notes...]");
  const score = Number(value);
  if (!Number.isFinite(score) || score < 1 || score > 5) {
    throw new UsageError(`grade must be a number between 1 and 5, got '${value}'.`);
  }

  const { db, paths } = openScope();
  const run = db
    .query<
      { model: string; category: string | null; status: RunStatus; created_at: string },
      [string]
    >(
      "SELECT model, category, status, created_at FROM runs WHERE id = ?",
    )
    .get(runId);
  if (!run) {
    console.error(`baton: unknown run '${runId}'. 'baton runs' lists the most recent ones.`);
    return 1;
  }
  const answering = db
    .query<{ target: string; started_at: string | null; finished_at: string | null }, [string]>(
      `SELECT target, started_at, finished_at FROM attempts
       WHERE run_id = ? AND status = 'succeeded' ORDER BY seq DESC LIMIT 1`,
    )
    .get(runId);
  if (!answering) {
    console.error(
      `baton: run ${runId} is ${run.status} and produced no answer to grade. Quality grades attach to answers; adapter and CLI failures are already recorded as reliability against the target.`,
    );
    return 1;
  }

  const revision = recordGrade(db, {
    runId,
    grade: score,
    ...(notes.length > 0 ? { notes: notes.join(" ") } : {}),
    category: run.category ?? "",
    target: answering.target,
    model: run.model,
    runAt: answering.finished_at ?? answering.started_at ?? run.created_at,
  });
  publishRatings(db, paths.configDir);
  console.log(
    `Graded run ${runId} ${score}/5 for ${run.model} via ${answering.target} (revision ${revision}).`,
  );
  return 0;
}

function set(args: string[]): number {
  const [key, value] = args;
  if (!key || value === undefined) return usage(`set needs: <key> <value>. ${validKeys()}`);

  if (key === SETTING_MAX_HOPS) {
    const hops = parseNonNegativeInt(value, SETTING_MAX_HOPS);
    return writeSetting(key, String(hops));
  }
  if (key === SETTING_MAX_CONCURRENT) {
    return writeSetting(key, String(parsePositiveInt(value, SETTING_MAX_CONCURRENT)));
  }
  if (key === SETTING_HALF_LIFE_DAYS) return setHalfLife(value, args.slice(2));
  if (key === SETTING_PROFILE_WEIGHT) {
    return writeSetting(key, String(parsePositiveNumber(value, SETTING_PROFILE_WEIGHT)), {
      ratings: true,
    });
  }
  if (key === SETTING_ACTIVE_PROFILE) return activateProfile(value);
  if (key.startsWith(SETTING_PRECIOUSNESS_PREFIX)) return setPreciousness(key, value);
  if (key.startsWith(SETTING_MAX_AUTONOMY_PREFIX)) {
    requireKnownApp(key.slice(SETTING_MAX_AUTONOMY_PREFIX.length), key);
    return writeSetting(key, parseAutonomy(value));
  }
  return usage(`unknown setting '${key}'. ${validKeys()}`);
}

/**
 * The accumulator stores sums already decayed under the current half-life, so
 * changing it reinterprets evidence that was never weighted that way. The store
 * refuses while any exists; `--reset-evidence` discards the aggregates in the
 * same commit as the new setting. Graded runs are private history, not
 * evidence, and are kept.
 */
function setHalfLife(value: string, rest: string[]): number {
  const { flags, rest: extra } = parseFlags(rest, { boolean: ["reset-evidence"] });
  if (extra.length > 0) {
    return usage(`set ${SETTING_HALF_LIFE_DAYS} takes one value, got '${extra[0]}'.`);
  }
  return writeSetting(
    SETTING_HALF_LIFE_DAYS,
    String(parsePositiveInt(value, SETTING_HALF_LIFE_DAYS)),
    { ratings: true, resetEvidence: flags["reset-evidence"] === true },
  );
}

/** Per (app, instance), and the instance need not exist yet — preciousness is
 * an opinion about an account, collected before or after it is defined. */
function setPreciousness(key: string, value: string): number {
  const rest = key.slice(SETTING_PRECIOUSNESS_PREFIX.length);
  const colon = rest.indexOf(":");
  const app = colon === -1 ? "" : rest.slice(0, colon);
  const instance = colon === -1 ? "" : rest.slice(colon + 1);
  if (!app || !instance) {
    return usage(`'${key}' must be ${SETTING_PRECIOUSNESS_PREFIX}<app>:<instance>.`);
  }
  requireKnownApp(app, key);
  if (!(value in PRECIOUSNESS_FACTOR)) {
    return usage(
      `invalid preciousness '${value}'. Expected one of: ${Object.keys(PRECIOUSNESS_FACTOR).join(", ")}.`,
    );
  }
  return writeSetting(preciousnessKey(app, instance), value);
}

/** Switching profiles swaps the prior; nothing observed is overwritten. */
function activateProfile(name: string): number {
  const { db, paths } = openScope();
  const known = db
    .query<{ profile: string }, []>("SELECT DISTINCT profile FROM priors ORDER BY profile")
    .all()
    .map((r) => r.profile);
  if (!known.includes(name)) {
    return usage(
      known.length > 0
        ? `unknown profile '${name}'. Known profiles: ${known.join(", ")}.`
        : `unknown profile '${name}'. This scope has no profiles yet — seed one with the seed_ratings tool, or 'baton profile import <file> --yes'.`,
    );
  }
  setActiveProfile(db, name);
  publishRatings(db, paths.configDir);
  console.log(`${SETTING_ACTIVE_PROFILE} = ${name}`);
  return 0;
}

/**
 * Settings that change what ratings.yaml would say are outcome commits too:
 * they bump the revision in the same transaction, otherwise the publisher
 * discards the refreshed render as stale (PLAN.md §Publication protocol).
 */
function writeSetting(
  key: string,
  value: string,
  opts: { ratings?: boolean; resetEvidence?: boolean } = {},
): number {
  const { db, paths } = openScope();
  if (opts.ratings) {
    setRatingSetting(db, key, value, { resetEvidence: opts.resetEvidence === true });
    publishRatings(db, paths.configDir);
  } else {
    withBusyRetry(() =>
      db
        .query(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        )
        .run(key, value),
    );
  }
  console.log(`${key} = ${value}`);
  return 0;
}

function install(args: string[]): number {
  const { flags, rest } = parseFlags(args, { value: ["dir"], boolean: ["with-eval"] });
  const host = rest[0];
  if (!host) return usage(`install needs a host: ${INSTALL_HOSTS.join(", ")}`);
  if (!isInstallHost(host)) {
    return usage(`unsupported host '${host}'. Supported: ${INSTALL_HOSTS.join(", ")}.`);
  }

  const target = flags.dir === undefined ? process.cwd() : resolve(String(flags.dir));
  const res = installHost(host, target, { withEval: flags["with-eval"] === true });
  console.log(`Registered MCP server 'baton' in ${res.mcpPath}`);
  console.log(`  command: ${[res.command, ...res.args].join(" ")}`);
  if (res.preserved.length > 0) console.log(`  kept: ${res.preserved.join(", ")}`);
  console.log(`Wrote instructions to ${res.instructionsPath}`);
  if (flags["with-eval"] === true) console.log("  including the grading + onboarding section");
  if (res.mcpNote) console.log(`Note: ${res.mcpNote}`);
  console.log(res.restart);
  return 0;
}

function usage(problem: string): number {
  console.error(`baton: ${problem}

Usage:
  baton status                            Scope, identity env, adapter availability
  baton detect                            Installed agent CLIs, versions, models
  baton models                            Models reachable in this scope
  baton run <model> <prompt...>           Delegate once from the shell
      --cwd <dir> --timeout <ms> --autonomy <readonly|edits|full>
      --instance <name>                   ('-' as the prompt reads stdin)
  baton runs [<run-id>]                   Recent runs, or one run in detail
  baton instance add <app> <name> --env KEY=VAL
  baton instance list
  baton instance remove <app> <name>
  baton pool set <app> <instance...>      Load-balance an app across instances
  baton pool list | pool clear <app>
  baton ratings [publish]                 Show ratings, or refresh ratings.yaml
  baton grade <run-id> <1-5> [notes...]   Grade a run after using its result
  baton profile import <file> [--name <n>] [--activate] [--yes]
  baton set <key> <value>                 ${validKeys()}
  baton install <host> [--dir <dir>] [--with-eval]
      hosts: ${INSTALL_HOSTS.join(", ")}
`);
  return 2;
}

function validKeys(): string {
  return `Valid keys: ${SETTING_MAX_HOPS} <int>, ${SETTING_MAX_CONCURRENT} <int>, ${SETTING_HALF_LIFE_DAYS} <int>, ${SETTING_PROFILE_WEIGHT} <number>, ${SETTING_ACTIVE_PROFILE} <profile>, ${SETTING_PRECIOUSNESS_PREFIX}<app>:<instance> <${Object.keys(
    PRECIOUSNESS_FACTOR,
  ).join("|")}>, ${knownApps()
    .map((app) => `${SETTING_MAX_AUTONOMY_PREFIX}${app}`)
    .join(", ")} <${AUTONOMY_ORDER.join("|")}>.`;
}

function knownApps(): string[] {
  return builtinAdapters.map((spec) => spec.app).sort();
}

function requireKnownApp(app: string, where?: string): void {
  if (getAdapter(app)) return;
  throw new UsageError(
    `unknown app '${app}'${where ? ` in '${where}'` : ""}. Known apps: ${knownApps().join(", ")}.`,
  );
}

function openDb(): Database {
  return openScope().db;
}

/** The DB plus the config dir the derived ratings projection lives in. */
function openScope(): { db: Database; paths: BatonPaths } {
  const paths: BatonPaths = ensurePaths(resolvePaths(process.env));
  return { db: openStore(paths.dbPath), paths };
}

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Cannot read ${path}: ${message(err)}`);
  }
}

async function readPrompt(parts: string[]): Promise<string> {
  if (parts.length === 1 && parts[0] === "-") return (await Bun.stdin.text()).trim();
  return parts.join(" ").trim();
}

function parseAutonomy(value: string): Autonomy {
  if ((AUTONOMY_ORDER as string[]).includes(value)) return value as Autonomy;
  throw new UsageError(
    `invalid autonomy '${value}'. Expected one of: ${AUTONOMY_ORDER.join(", ")}.`,
  );
}

function parsePositiveInt(value: string, label: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0 || String(n) !== value.trim()) {
    throw new UsageError(`${label} expects a positive integer, got '${value}'.`);
  }
  return n;
}

function parsePositiveNumber(value: string, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new UsageError(`${label} expects a positive number, got '${value}'.`);
  }
  return n;
}

function parseNonNegativeInt(value: string, label: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0 || String(n) !== value.trim()) {
    throw new UsageError(`${label} expects a non-negative integer, got '${value}'.`);
  }
  return n;
}

function hopDepth(env: Record<string, string | undefined>): number {
  const depth = Number.parseInt(env[HOPS_ENV] ?? "0", 10);
  return Number.isFinite(depth) && depth > 0 ? depth : 0;
}

interface FlagSchema {
  /** Flags taking one value; last wins. */
  value?: string[];
  /** Flags taking one value, collected into a list. */
  repeat?: string[];
  /** Flags taking no value. */
  boolean?: string[];
}

type FlagValue = string | string[] | true;

/**
 * Hand-rolled parsing: `--key value`, `--key=value`, `--flag`, and `--` to end
 * flags so a prompt may start with a dash. Unknown flags are an error rather
 * than silently becoming prompt words.
 */
function parseFlags(
  args: string[],
  schema: FlagSchema,
): { flags: Record<string, FlagValue>; rest: string[] } {
  const flags: Record<string, FlagValue> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = (eq === -1 ? arg : arg.slice(0, eq)).slice(2);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);

    if (schema.boolean?.includes(name)) {
      flags[name] = true;
      continue;
    }
    const repeats = schema.repeat?.includes(name) ?? false;
    if (!repeats && !(schema.value?.includes(name) ?? false)) {
      throw new UsageError(`unknown flag '--${name}'.`);
    }
    const value = inline ?? args[++i];
    if (value === undefined) throw new UsageError(`--${name} needs a value.`);
    if (repeats) flags[name] = [...asList(flags[name]), value];
    else flags[name] = value;
  }
  return { flags, rest };
}

function asList(value: FlagValue | undefined): string[] {
  if (value === undefined || value === true) return [];
  return Array.isArray(value) ? value : [value];
}

function envSummary(json: string): string {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return json;
    return Object.entries(parsed as Record<string, unknown>)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ");
  } catch {
    return json;
  }
}

function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** Display precision: integers stay integers, everything else gets two decimals. */
function fixed(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function preview(prompt: string): string {
  const flat = prompt.replaceAll(/\s+/g, " ").trim();
  return flat.length <= PROMPT_PREVIEW_CHARS ? flat : `${flat.slice(0, PROMPT_PREVIEW_CHARS)}…`;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function age(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "?";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface RunListRow {
  id: string;
  model: string;
  status: RunStatus;
  created_at: string;
  prompt: string;
}

interface RunDetailRow extends RunListRow {
  app: string;
  slug: string;
  instance: string;
  cwd: string;
  category: string | null;
  updated_at: string;
}

interface AttemptDetailRow {
  seq: number;
  target: string;
  status: RunStatus;
  exit_code: number | null;
  error: string | null;
  output: string | null;
  started_at: string | null;
  finished_at: string | null;
}
