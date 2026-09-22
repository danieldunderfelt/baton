import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { builtinAdapters, getAdapter } from "../adapters/builtin/index.ts";
import {
  AUTONOMY_ORDER,
  DEFAULT_INSTANCE,
  type Autonomy,
} from "../adapters/types.ts";
import { ensurePaths, resolvePaths, type BatonPaths } from "../config/paths.ts";
import { listDiscovered } from "../discovery/discovery.ts";
import { runAdapters } from "./adapters.ts";
import {
  blindDuelOf,
  blindRuns,
  btRatings,
  currentEdges,
  duelView,
  reportDuel,
  startDuel,
  type Winner,
} from "../eval/duels.ts";
import type { DuelView } from "../eval/duelTypes.ts";
import {
  activeProfile,
  recordGrade,
  setActiveProfile,
  setRatingSetting,
  type PriorDiff,
  type PriorRef,
} from "../eval/evalStore.ts";
import type { ProfileDocument } from "../eval/profileDocument.ts";
import {
  diffProfileDocument,
  exportProfile,
  importProfileDocument,
  parseProfileDocument,
  renderProfile,
} from "../eval/profileFile.ts";
import { exportRatings, snapshotRatings } from "../eval/publish.ts";
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
import { activeCooldowns } from "../quota/quota.ts";
import {
  addBlock,
  blockFor,
  listBlocks,
  normalizePattern,
  removeBlock,
  routeKey,
  type RouteBlock,
} from "../registry/blocks.ts";
import {
  catalogFor,
  detectApps,
  instanceEnvironment,
  listModels,
  routableAdapters,
} from "../registry/registry.ts";
import { inTransaction, nowIso, openStore, withBusyRetry } from "../store/store.ts";
import { createSupervisor, type Supervisor } from "../supervisor/supervisor.ts";
import {
  HOPS_ENV,
  SETTING_MAX_AUTONOMY_PREFIX,
  SETTING_MAX_HOPS,
  type RunStatus,
  type RunView,
} from "../supervisor/types.ts";
import {
  INSTALL_HOSTS,
  detectedHosts,
  installHost,
  refreshInstalledSkills,
  isInstallHost,
  type InstallHost,
  type InstallScope,
} from "./install.ts";
import {
  clearAuth,
  deviceLogin,
  fetchShare,
  isUnauthorized,
  listShares,
  parseShareRef,
  readAuth,
  revokeShare,
  revokeToken,
  shareProfile,
  siteUrl,
  writeAuth,
  type AuthFile,
} from "./share.ts";
import { COMMANDS, HELP, helpFor, wantsHelp } from "./help.ts";
import { CURRENT_VERSION, selfUpdate } from "./update.ts";

/**
 * The trusted face of Baton: the only place the authority ceiling and instance
 * definitions can be written (never through a tool call).
 * Everything reads and writes the scope resolved from BATON_CONFIG_DIR.
 */

/**
 * Identity vars printed by `status`: the env overlays that actually move an
 * app's credentials. Deliberately wider than the registry (status reports the
 * environment the user is standing in), but not wider than the truth.
 */
const IDENTITY_ENV = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "KIMI_CODE_HOME",
  "XDG_DATA_HOME",
] as const;

const RUNS_LIMIT = 20;
const PROMPT_PREVIEW_CHARS = 60;

export async function runCli(command: string, args: string[]): Promise<number> {
  try {
    if (!COMMANDS.includes(command)) return usage(`unknown command '${command}'`);
    if (wantsHelp(args)) {
      console.log(helpFor(command));
      return 0;
    }
    if (["detect", "update", "upgrade"].includes(command) && args.length > 0) {
      return usage(`${command} takes no arguments, got '${args[0]}'.`);
    }
    switch (command) {
      case "status":
        return await status(args);
      case "detect":
        return await detect();
      case "models":
        return await models(args);
      case "run":
        return await run(args);
      case "resume":
        return await resume(args);
      case "runs":
        return runs(args);
      case "cancel":
        return await cancelRun(args);
      case "duel":
        return await duel(args);
      case "adapters":
        return await adapters(args);
      case "serve":
        return await serve(args);
      case "instance":
        return instance(args);
      case "pool":
        return pool(args);
      case "block":
        return await block(args);
      case "ratings":
        return ratings(args);
      case "profile":
        return await profile(args);
      case "login":
        return await login(args);
      case "logout":
        return await logout(args);
      case "grade":
        return grade(args);
      case "set":
        return set(args);
      case "install":
        return install(args);
      case "update":
      case "upgrade":
        return await update();
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

async function status(args: string[]): Promise<number> {
  const { flags, rest } = parseFlags(args, { boolean: ["json"] });
  if (rest.length) return usage("status takes no positional arguments");
  const env = process.env;
  const paths = resolvePaths(env);
  const rows: string[][] = [
    ["scope", paths.scoped ? `${env.BATON_CONFIG_DIR} (BATON_CONFIG_DIR)` : "default (XDG)"],
    ["version", CURRENT_VERSION],
    ["executable", process.execPath],
    ["configDir", paths.configDir],
    ["dbPath", paths.dbPath],
    ["hops", `${hopDepth(env)} (${HOPS_ENV}=${env[HOPS_ENV] ?? "unset"})`],
  ];
  for (const key of IDENTITY_ENV) rows.push([key, env[key] ?? "(unset)"]);
  const { db } = openScope();
  const adapters = await detectApps({ probeVersion: false, db });
  if (flags.json) {
    console.log(JSON.stringify({ version: CURRENT_VERSION, executable: process.execPath, paths, hops: hopDepth(env), identityEnv: Object.fromEntries(IDENTITY_ENV.map((key) => [key, env[key] ?? null])), adapters }));
    return 0;
  }
  console.log(table(rows));
  console.log("\nadapters:");
  for (const app of adapters) {
    console.log(`  ${app.app.padEnd(12)} ${app.binaryPath ?? "not on PATH in this scope"}`);
  }
  return 0;
}

async function detect(): Promise<number> {
  const { db } = openScope();
  const specs = new Map(routableAdapters(db).map((spec) => [spec.app, spec]));
  const [apps, models] = await Promise.all([detectApps({ db }), listModels(db)]);
  const rows: string[][] = [["APP", "BINARY", "VERSION", "MODELS"]];
  const listingErrors: string[] = [];
  for (const app of apps) {
    const spec = specs.get(app.app)!;
    const catalog = models.filter((model) => model.app === app.app);
    for (const error of new Set(catalog.flatMap((model) => model.catalogError ? [model.catalogError] : []))) {
      listingErrors.push(`${app.app}: ${error}`);
    }
    // The pinned ids by name; the rest as a count, since an app can report
    // hundreds and 'baton models' is the place for the full list.
    const reported = catalog.length - spec.models.length;
    const pinned = spec.models.map((m) => m.model).join(", ");
    rows.push([
      app.app,
      app.binaryPath ?? "(not found)",
      app.version ?? "-",
      reported > 0 ? `${pinned} +${reported} reported by the app` : pinned,
    ]);
  }
  console.log(table(rows));
  for (const error of listingErrors) {
    console.log(`\n${error} — only its pinned models route until the listing works.`);
  }

  return 0;
}

async function models(args: string[]): Promise<number> {
  const { flags, rest } = parseFlags(args, { boolean: ["json"] });
  if (rest.length) return usage("models takes no positional arguments");
  const db = openDb();
  const listing = await listModels(db);
  if (flags.json) {
    console.log(JSON.stringify(listing));
    return 0;
  }
  // "no" on its own sends the user hunting: the reason is the actionable half,
  // and for a blocked route it is the user's own words coming back to them.
  const rows: string[][] = [["MODEL", "ROUTE", "AVAILABLE", "MAX AUTONOMY", "SUPPORTED", "WHY NOT"]];
  for (const m of listing) {
    rows.push([
      m.model,
      `${m.app}/${m.slug}`,
      m.available ? "yes" : "no",
      m.maxAutonomy,
      m.supportedAutonomies.join(",") || "-",
      m.degradedReason ?? "-",
    ]);
  }
  console.log(table(rows));
  return 0;
}

async function run(args: string[]): Promise<number> {
  const { flags, rest } = parseFlags(args, {
    value: ["cwd", "timeout", "autonomy", "instance"],
    boolean: ["json"],
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
  const started = await supervisor.startRun({
    model,
    prompt,
    ...(flags.cwd === undefined ? {} : { cwd: resolve(String(flags.cwd)) }),
    ...(flags.instance === undefined ? {} : { instance: String(flags.instance) }),
    options: {
      ...(autonomy ? { autonomy } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    },
  });
  return await settle(supervisor, started, flags.json === true);
}

/**
 * Continue a session on its original instance, inheriting omitted options.
 */
async function resume(args: string[]): Promise<number> {
  const { flags, rest } = parseFlags(args, { value: ["timeout", "autonomy"], boolean: ["json"] });
  const runId = rest[0];
  if (!runId) return usage("resume needs a run: baton resume <run-id> <prompt...>");
  const prompt = await readPrompt(rest.slice(1));
  if (!prompt) return usage("resume needs a prompt (or '-' to read one from stdin)");

  const autonomy = flags.autonomy === undefined ? undefined : parseAutonomy(String(flags.autonomy));
  const timeoutMs =
    flags.timeout === undefined ? undefined : parsePositiveInt(String(flags.timeout), "--timeout");

  const db = openDb();
  const supervisor = createSupervisor({ db, env: { ...process.env }, hostCwd: process.cwd() });
  const started = await supervisor.resumeRun({
    runId,
    prompt,
    options: {
      ...(autonomy ? { autonomy } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    },
  });
  return await settle(supervisor, started, flags.json === true);
}

/**
 * Waits for a launched run and prints its answer. There is no --no-wait: this
 * process is the supervisor, so detaching would orphan the record. Async
 * delegation is the MCP server's job (wait:false), because that server outlives
 * the call.
 */
async function settle(
  supervisor: Supervisor,
  started: { view: RunView; settled: Promise<void> },
  json: boolean,
): Promise<number> {
  console.error(`baton: run ${started.view.runId} ${started.view.status}`);
  console.error(`baton: permissions ${started.view.options.autonomy}; timeout ${started.view.options.timeoutMs === undefined ? "none" : `${started.view.options.timeoutMs} ms`}`);
  const release = guardCancellation(supervisor, [started.view.runId]);
  try {
    await started.settled;
  } finally {
    release();
  }
  const final = supervisor.getRun(started.view.runId) ?? started.view;
  console.error(`baton: run ${final.runId} ${final.status}`);
  if (json) console.log(JSON.stringify(final));
  if (final.status === "succeeded") {
    if (!json) console.log(final.output ?? "");
    return 0;
  }
  console.error(`baton: run ${final.runId} ${final.status}: ${final.error ?? "no error recorded"}`);
  return 1;
}

/** Wait for the supervisor to stop and settle its processes before exiting on a signal. */
function guardCancellation(supervisor: Supervisor, runIds: string[]): () => void {
  let cancelling = false;
  const cancel = async (exitCode: number): Promise<void> => {
    if (cancelling) return;
    cancelling = true;
    await supervisor.shutdown();
    console.error(`baton: run ${runIds.join(", ")} cancelled`);
    process.exit(exitCode);
  };
  const sigint = (): void => void cancel(130);
  const sigterm = (): void => void cancel(143);
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);
  return () => {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
  };
}

function runs(args: string[]): number {
  const db = openDb();
  const { flags, rest } = parseFlags(args, { boolean: ["json"] });
  if (rest.length > 1) return usage("runs takes at most one run id");
  const runId = rest[0];
  if (!runId) return runList(db, flags.json === true);

  const row = db
    .query<RunDetailRow, [string]>(
      "SELECT id, model, app, slug, instance, status, cwd, category, prompt, created_at, updated_at FROM runs WHERE id = ?",
    )
    .get(runId);
  if (!row) {
    console.error(`baton: unknown run '${runId}'. 'baton runs' lists the most recent ones.`);
    return 1;
  }

  if (flags.json) {
    const supervisor = createSupervisor({ db, env: { ...process.env }, hostCwd: process.cwd() });
    const view = supervisor.getRun(runId);
    const duelId = blindDuelOf(db, runId);
    console.log(JSON.stringify(view && publicRunView(view, duelId)));
    return 0;
  }

  // A side of an unjudged duel describes itself by label only: model, route and
  // attempt targets are exactly what `duel report` reveals.
  const blindDuel = blindDuelOf(db, runId);
  console.log(
    table([
      ["run", row.id],
      [
        "model",
        blindDuel === undefined
          ? `${row.model} via ${row.app}:${row.instance}/${row.slug}`
          : `${blindLabel(blindDuel)} — 'baton duel report ${blindDuel} <A|B|tie>' reveals it`,
      ],
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
    console.log(`  #${a.seq} ${blindDuel === undefined ? a.target : "(blind)"}`);
    console.log(
      `     ${a.status}  exit=${a.exit_code ?? "-"}  started=${a.started_at ?? "-"}  finished=${a.finished_at ?? "-"}`,
    );
    // An error names the binary that produced it, so it is withheld too.
    if (a.error) console.log(`     error: ${blindDuel === undefined ? a.error : "run failed"}`);
  }

  console.log(`\nprompt:\n${indent(row.prompt)}`);
  const output = attempts.findLast((a) => a.output)?.output;
  if (output) console.log(`\noutput:\n${indent(output)}`);
  return 0;
}

function runList(db: Database, json = false): number {
  const rows = db
    .query<RunListRow, [number]>(
      "SELECT id, model, status, created_at, prompt FROM runs ORDER BY created_at DESC, id DESC LIMIT ?",
    )
    .all(RUNS_LIMIT);
  const blind = blindRuns(db);
  if (json) {
    console.log(JSON.stringify(rows.map((row) => {
      const duelId = blind.get(row.id);
      return { runId: row.id, model: duelId ? blindLabel(duelId) : row.model, status: row.status, createdAt: row.created_at, prompt: row.prompt };
    })));
    return 0;
  }
  if (rows.length === 0) {
    console.log("No runs in this scope yet.");
    return 0;
  }
  const table_: string[][] = [["ID", "MODEL", "STATUS", "AGE", "PROMPT"]];
  for (const r of rows) {
    const duelId = blind.get(r.id);
    table_.push([
      r.id,
      duelId === undefined ? r.model : blindLabel(duelId),
      r.status,
      age(r.created_at),
      preview(r.prompt),
    ]);
  }
  console.log(table(table_));
  return 0;
}

async function cancelRun(args: string[]): Promise<number> {
  const { flags, rest } = parseFlags(args, { boolean: ["json"] });
  const [runId] = rest;
  if (!runId || rest.length !== 1) return usage("cancel needs one run id: baton cancel <run-id>");
  const db = openDb();
  const supervisor = createSupervisor({ db, env: { ...process.env }, hostCwd: process.cwd() });
  let view = supervisor.getRun(runId);
  if (!view) throw new Error(`unknown run '${runId}'`);
  if (view.status === "running" || view.status === "queued") {
    supervisor.cancelRun(runId);
    console.error(`baton: cancelling run ${runId}`);
    do {
      view = await supervisor.waitForRun(runId, 1_000);
    } while (view.status === "running" || view.status === "queued");
  }
  if (flags.json) console.log(JSON.stringify(publicRunView(view, blindDuelOf(db, runId))));
  else console.log(`Run ${runId} ${view.status}.`);
  return 0;
}

/** How an unjudged duel's side names itself everywhere a model would appear. */
function publicRunView(view: RunView, duelId: string | undefined): RunView | Record<string, unknown> {
  return duelId === undefined ? view : {
    runId: view.runId, status: view.status, model: blindLabel(duelId), output: view.output,
    createdAt: view.createdAt,
  };
}

function blindLabel(duelId: string): string {
  return `duel ${duelId} (blind)`;
}

/**
 * Blind A/B. Both sides run with identical prompt,
 * options and cwd, and the two answers are printed under labels only: a judge
 * who knows which model wrote which text is rating the name, not the answer.
 * `duel report` is the single place the mapping is revealed.
 */
async function duel(args: string[]): Promise<number> {
  switch (args[0]) {
    case "report":
      return duelReport(args.slice(1));
    case "list":
      return duelList();
    default:
      return await duelStart(args);
  }
}

const DUEL_POLL_MS = 250;
const DUELS_LIMIT = 20;

async function duelStart(args: string[]): Promise<number> {
  const { flags, rest } = parseFlags(args, { value: ["category", "cwd", "timeout"] });
  const [modelA, modelB] = rest;
  if (!modelA || !modelB) {
    return usage("duel needs two models: baton duel <modelA> <modelB> <prompt...>");
  }
  const prompt = await readPrompt(rest.slice(2));
  if (!prompt) return usage("duel needs a prompt (or '-' to read one from stdin)");
  const timeoutMs =
    flags.timeout === undefined ? undefined : parsePositiveInt(String(flags.timeout), "--timeout");

  const db = openDb();
  const supervisor = createSupervisor({ db, env: { ...process.env }, hostCwd: process.cwd() });
  const started = await startDuel(
    { db, supervisor },
    {
      models: [modelA, modelB],
      prompt,
      ...(flags.category === undefined ? {} : { category: String(flags.category) }),
      ...(flags.cwd === undefined ? {} : { cwd: resolve(String(flags.cwd)) }),
      ...(timeoutMs === undefined ? {} : { options: { timeoutMs } }),
    },
  );

  const release = guardCancellation(
    supervisor,
    started.runs.map((r) => r.runId),
  );
  let view: DuelView;
  try {
    view = await settleDuel(db, supervisor, started.duelId);
  } finally {
    release();
  }
  if (view.status !== "awaiting_judgment") {
    console.error(
      `baton: duel ${view.duelId} is void — a side produced no answer, and a side that never answered cannot lose. 'baton runs' has the detail.`,
    );
    return 1;
  }

  for (const side of view.runs) {
    console.log(`──── ${side.label} ────`);
    console.log(supervisor.getRun(side.runId)?.output ?? "");
    console.log("");
  }
  console.log(`judge with: baton duel report ${view.duelId} <A|B|tie>`);
  return 0;
}

/** Both runs settle on their own; the duel is polled, never awaited. */
async function settleDuel(
  db: Database,
  supervisor: Supervisor,
  duelId: string,
): Promise<DuelView> {
  for (;;) {
    const view = duelView(db, supervisor, duelId);
    if (view.status !== "running") return view;
    await Bun.sleep(DUEL_POLL_MS);
  }
}

/** Judgment, and the only reveal: the mapping is printed after the verdict. */
function duelReport(args: string[]): number {
  const [duelId, verdict] = args;
  if (!duelId || verdict === undefined) {
    return usage("duel report needs: <duel-id> <A|B|tie>");
  }
  const winner = parseWinner(verdict);
  const db = openDb();
  const view = reportDuel(db, duelId, winner);
  const revealed = view.revealed ?? { A: "?", B: "?" };
  console.log(
    table([
      ["duel", view.duelId],
      ["category", view.category || "-"],
      ["winner", view.winner ?? "-"],
      ["A was", revealed.A],
      ["B was", revealed.B],
    ]),
  );
  return 0;
}

function parseWinner(value: string): Winner {
  const normalized = value.trim().toLowerCase();
  if (normalized === "a") return "A";
  if (normalized === "b") return "B";
  if (normalized === "tie") return "tie";
  throw new UsageError(`duel winner must be 'A', 'B' or 'tie', got '${value}'.`);
}

function duelList(): number {
  const db = openDb();
  const supervisor = createSupervisor({ db, env: { ...process.env }, hostCwd: process.cwd() });
  const ids = db
    .query<{ id: string }, [number]>(
      "SELECT id FROM duels ORDER BY created_at DESC, id DESC LIMIT ?",
    )
    .all(DUELS_LIMIT);
  if (ids.length === 0) {
    console.log("No duels in this scope yet. 'baton duel <modelA> <modelB> <prompt...>' starts one.");
    return 0;
  }
  const rows: string[][] = [["ID", "CATEGORY", "STATUS", "WINNER", "MODELS", "AGE"]];
  for (const { id } of ids) {
    const view = duelView(db, supervisor, id);
    rows.push([
      view.duelId,
      view.category || "-",
      view.status,
      view.winner ?? "-",
      view.revealed ? `A=${view.revealed.A} B=${view.revealed.B}` : "(blind until judged)",
      age(view.createdAt),
    ]);
  }
  console.log(table(rows));
  return 0;
}

async function adapters(args: string[]): Promise<number> {
  return runAdapters(openDb(), args);
}

/**
 * The stateless Streamable-HTTP face, one daemon per environment scope.
 * A daemon inherits one environment, so it serves
 * exactly the scope it was started in.
 */
async function serve(args: string[]): Promise<number> {
  const { flags, rest } = parseFlags(args, { value: ["port"], boolean: ["http"] });
  if (rest.length > 0) return usage(`serve takes no positional arguments, got '${rest[0]}'.`);
  if (flags.http !== true) {
    return usage("serve needs --http; the stdio server is 'baton mcp' (that is what hosts register).");
  }
  // 0 is meaningful here: it asks the OS for a free port, which the printed url
  // then reports.
  const port =
    flags.port === undefined ? undefined : parseNonNegativeInt(String(flags.port), "--port");
  const { serveHttp } = await import("../mcp/http.ts");
  const daemon = serveHttp(port === undefined ? {} : { port });
  console.log(
    table([
      ["url", daemon.url],
      ["scope", daemon.configDir],
    ]),
  );
  console.log("\nServing the same tools as 'baton mcp'. Ctrl-C stops it and its callees.");
  // The daemon owns the process from here; its signal handlers are the exit.
  await new Promise<never>(() => {});
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
  const db = openDb();
  const spec = routableAdapters(db).find((candidate) => candidate.app === app);
  if (!spec) return usage(`unknown app '${app}'. Known apps: ${knownApps(db).join(", ")}.`);
  if (name === "default") {
    return usage("'default' is the inherited environment and cannot be redefined.");
  }
  // An app whose identity cannot be relocated by an env var has exactly one
  // account, whatever we name it. Opencode credentials follow neither a
  // config-dir variable nor HOME.
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
 * Pools are trusted configuration, which is exactly why they are set here and not
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
      const cooling = activeCooldowns(db, p.app, c.instance, now)
        .map(({ scope, until }) => scope ? `${scope}: ${until}` : until).join(", ");
      rows.push([p.app, c.instance, c.preciousness, fixed(c.headroom), cooling || "-"]);
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
 * Route blocks: the deny list for routes Baton can reach but must not spend.
 * Baton still does not verify identity —
 * this is the user saying which reachable routes are off limits, and Baton
 * obeying without pretending to know whose account is behind one.
 */
async function block(args: string[]): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case "add":
      return await blockAdd(args.slice(1));
    case "list":
      return await blockList();
    case "remove":
      return blockRemove(args.slice(1));
    default:
      return usage("block takes: add <pattern> [reason...] | list | remove <pattern>");
  }
}

/**
 * The confirmation is the routes it blocks right now — a deny list that
 * silently matches nothing is worse than no deny list, and a typo in a slug is
 * invisible otherwise.
 */
async function blockAdd(args: string[]): Promise<number> {
  const [pattern, ...reason] = args;
  if (!pattern) {
    return usage(
      "block add needs: <pattern> [reason...], e.g. baton block add 'opencode/github-copilot/*' client subscription",
    );
  }
  const db = openDb();
  const saved = addBlock(db, pattern, reason.length > 0 ? reason.join(" ") : undefined);
  console.log(`Blocked ${saved.pattern}${saved.reason ? ` (${saved.reason})` : ""}`);
  await printMatches(db, saved.pattern);
  return 0;
}

async function blockList(): Promise<number> {
  const db = openDb();
  const blocks = listBlocks(db);
  if (blocks.length === 0) {
    console.log(
      "No blocked routes in this scope. 'baton block add <app>[:<instance>]/<slug>' adds one ('*' wildcards).",
    );
    return 0;
  }
  const rows: string[][] = [["PATTERN", "ROUTES", "REASON"]];
  for (const b of blocks) {
    rows.push([b.pattern, String((await matchingRoutes(db, b.pattern)).length), b.reason ?? "-"]);
  }
  console.log(table(rows));
  return 0;
}

function blockRemove(args: string[]): number {
  const pattern = args[0];
  if (!pattern) return usage("block remove needs: <pattern> (as 'baton block list' shows it)");
  const db = openDb();
  if (!removeBlock(db, pattern)) {
    console.error(
      `baton: no block '${normalizePattern(pattern)}' in this scope. 'baton block list' shows them.`,
    );
    return 1;
  }
  console.log(`Unblocked ${normalizePattern(pattern)}`);
  return 0;
}

/** Routes this scope knows that the pattern covers, as `app:instance/slug`. */
async function matchingRoutes(db: Database, pattern: string): Promise<string[]> {
  const one: RouteBlock[] = [{ pattern, createdAt: "" }];
  const keys: string[] = [];
  for (const spec of routableAdapters(db)) {
    const instances = [
      DEFAULT_INSTANCE,
      ...(spec.identityEnv ? instanceNames(db, spec.app) : []),
    ];
    for (const instance of instances) {
      for (const route of (await catalogFor(spec, instanceEnvironment(db, spec.app, instance))).routes) {
        if (blockFor(one, spec.app, instance, route.slug)) {
          keys.push(routeKey(spec.app, instance, route.slug));
        }
      }
    }
  }
  return keys;
}

async function printMatches(db: Database, pattern: string): Promise<void> {
  const matches = await matchingRoutes(db, pattern);
  if (matches.length === 0) {
    console.log(
      "It matches no route this scope currently knows — check the app and slug against 'baton models', or leave it as a standing rule for a route that does not exist yet.",
    );
    return;
  }
  for (const key of matches) console.log(`  ${key}`);
}

function instanceNames(db: Database, app: string): string[] {
  return db
    .query<{ name: string }, [string]>("SELECT name FROM instances WHERE app = ? ORDER BY name")
    .all(app)
    .map((r) => r.name);
}

/**
 * The ratings view: observed, prior and blended stay three visibly separate
 * numbers, because the whole point of the provenance split is that the user can
 * see which one is carrying a routing decision.
 */
function ratings(args: string[]): number {
  const sub = args[0];
  if (sub === "publish" || sub === "export") return ratingsPublish();
  if (sub !== undefined) return usage("ratings takes: (nothing) | export");

  const db = openDb();
  const snap = snapshotRatings(db);
  console.log(
    table([
      ["profile", snap.profile ?? "(none)"],
      ["profile weight", fixed(snap.profileWeight)],
      ["revision", String(snap.revision)],
    ]),
  );
  const bt = btSection(db);
  if (snap.rows.length === 0) {
    console.log(
      "\nNo ratings yet: grade a run with 'baton grade <run-id> <1-5>', or seed priors via the seed_ratings tool.",
    );
    if (bt) console.log(`\n${bt}`);
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
  if (bt) console.log(`\n${bt}`);
  return 0;
}

/**
 * Duel evidence, fitted and shown as its own signal: grade EMAs and BT are
 * reported separately and never merged. Absent
 * entirely until a duel has been judged, so an unused feature adds no noise.
 */
function btSection(db: Database, at = nowIso()): string | null {
  if (currentEdges(db, at).length === 0) return null;
  const rows: string[][] = [["MODEL", "CATEGORY", "STRENGTH", "SE", "COMPARISONS"]];
  const fitted = btRatings(db, at)
    // A model with a prior but no duels is fitted into every category to keep
    // the graph identified; it is not duel evidence and does not belong here.
    .filter((r) => r.nEff > 0)
    .sort((a, b) => a.category.localeCompare(b.category) || b.theta - a.theta);
  for (const r of fitted) {
    rows.push([r.model, r.category || "-", fixed(r.theta), fixed(r.se), fixed(r.nEff)]);
  }
  return `duels (Bradley-Terry — a separate signal, never blended into the grades above):\n${table(rows)}`;
}

function ratingsPublish(): number {
  const { db, paths } = openScope();
  const res = exportRatings(db, paths.configDir);
  console.log(`Exported ${res.path} at revision ${res.revision}`);
  return 0;
}

async function profile(args: string[]): Promise<number> {
  switch (args[0]) {
    case "import":
      return await profileImport(args.slice(1));
    case "export":
      return profileExport(args.slice(1));
    case "share":
      return await profileShare(args.slice(1));
    case "shares":
      return await profileShares(args.slice(1));
    case "unshare":
      return await profileUnshare(args.slice(1));
    default:
      return usage(
        "profile takes: import <file|code|url> [--name <n>] [--activate] [--dry-run] | export [--profile <n>] [--out <file>] | share [--profile <n>] | shares | unshare <code>",
      );
  }
}

/**
 * Portable by construction: the document is
 * canonical model priors and nothing else — no targets, instances, machine
 * details or prompts — which profileFile.ts guarantees at the format level.
 */
function profileExport(args: string[]): number {
  const { flags, rest } = parseFlags(args, { value: ["out", "profile"] });
  if (rest.length > 0) {
    return usage(`profile export takes no positional arguments, got '${rest[0]}'.`);
  }
  const db = openDb();
  const name = flags.profile === undefined ? activeProfile(db) : String(flags.profile);
  if (!name) {
    return usage(
      "profile export needs a profile: this scope has no active one. Name it with --profile <n>, or 'baton set active_profile <n>'.",
    );
  }
  const doc = exportProfile(db, name);
  const text = renderProfile(doc);
  if (flags.out === undefined) {
    process.stdout.write(text);
    return 0;
  }
  const path = resolve(String(flags.out));
  writeFileSync(path, text);
  console.log(`Exported profile '${name}' (${doc.entries.length} priors) to ${path}`);
  warnCategories(doc);
  return 0;
}

function warnCategories(doc: ProfileDocument): void {
  const categories = [...new Set(doc.entries.map((e) => e.category).filter(Boolean))];
  if (categories.length > 0) {
    console.log(
      `Note: category names are free text and export verbatim (${categories.join(", ")}) — check none name a client or project before sharing.`,
    );
  }
}

/** Import immediately; previews are explicit and replacements keep a portable backup. */
async function profileImport(args: string[]): Promise<number> {
  const { flags, rest } = parseFlags(args, { value: ["name"], boolean: ["activate", "dry-run", "yes"] });
  const [ref] = rest;
  if (!ref || rest.length !== 1) return usage("profile import needs: <file|code|url> [--name <n>] [--activate] [--dry-run]");
  const loaded = await loadProfile(ref);
  const { doc, source } = loaded;
  const target = flags.name === undefined ? loaded.defaultName : String(flags.name);
  const { db, paths } = openScope();
  if (loaded.from) console.log(loaded.from);
  if (flags["dry-run"]) {
    printDiff(source, target, diffProfileDocument(db, doc, target, undefined, source, true));
    console.log("\nNothing was written (--dry-run).");
    return 0;
  }
  let backup: string | undefined;
  const diff = inTransaction(db, () => {
    const activate = flags.activate === true || activeProfile(db) === null;
    const preview = diffProfileDocument(db, doc, target, undefined, source, true);
    const exists = db.query("SELECT 1 FROM priors WHERE profile = ? LIMIT 1").get(target);
    if (exists && (preview.changed.length || preview.removed.length || preview.added.length)) {
      const dir = join(paths.configDir, "profile-backups");
      mkdirSync(dir, { recursive: true });
      backup = join(dir, `${crypto.randomUUID()}.yaml`);
      writeFileSync(backup, renderProfile(exportProfile(db, target)), { mode: 0o600, flag: "wx" });
    }
    return importProfileDocument(db, doc, { name: target, activate, source, replace: true });
  });
  printDiff(diff.source, target, diff);
  console.log(`\nImported into profile '${target}' at revision ${diff.revision}.`);
  if (backup) console.log(`Previous version saved to ${backup}. Restore with: baton profile import '${backup}'`);
  console.log(activeProfile(db) === target
    ? `Active profile is now '${target}'.`
    : `Activate with: baton set ${SETTING_ACTIVE_PROFILE} '${target}'`);
  return 0;
}

interface LoadedProfile {
  doc: ProfileDocument;
  /** Provenance stamped on the priors: the file's name, or `login/name` for a share. */
  source: string;
  /** Local profile name when --name is not given. */
  defaultName: string;
  /** Where it came from, for the terminal; empty for a local file. */
  from: string;
}

/**
 * A file path, a share code, or a share link. A share lands under
 * `<login>/<name>` by default so it cannot collide with a profile of the same
 * name the recipient already nurtures.
 */
async function loadProfile(ref: string): Promise<LoadedProfile> {
  const path = resolve(ref);
  if (existsSync(path)) {
    const doc = parseProfileDocument(read(path), path);
    return { doc, source: doc.name, defaultName: doc.name, from: "" };
  }
  const share = parseShareRef(ref);
  if (!share) {
    throw new Error(`'${ref}' is neither a profile file nor a share code or link.`);
  }
  const site = share.site ?? siteUrl();
  const shared = await fetchShare(site, share.code);
  const source = `${shared.owner.login}/${shared.profile.name}`;
  return {
    doc: shared.profile,
    source,
    defaultName: source,
    from: `Fetched ${shared.url}: '${shared.profile.name}' shared by @${shared.owner.login}, updated ${day(shared.updated_at)}.`,
  };
}

/**
 * Publishing goes through the same export as a file, so the portability
 * guarantee holds: canonical priors, nothing local. Re-sharing a profile name
 * refreshes the existing share, so a link already handed out stays current.
 */
async function profileShare(args: string[]): Promise<number> {
  const { flags, rest } = parseFlags(args, { value: ["profile"] });
  if (rest.length > 0) {
    return usage(`profile share takes no positional arguments, got '${rest[0]}'.`);
  }
  const { db, paths } = openScope();
  const name = flags.profile === undefined ? activeProfile(db) : String(flags.profile);
  if (!name) {
    return usage(
      "profile share needs a profile: this scope has no active one. Name it with --profile <n>, or 'baton set active_profile <n>'.",
    );
  }
  const doc = exportProfile(db, name);
  warnCategories(doc);
  const site = siteUrl();
  const auth = readAuth(paths.configDir, site) ?? (await signIn(paths.configDir, site));
  const share = await withAuth(paths.configDir, () => shareProfile(site, auth.token, doc));
  console.log(
    `${share.created ? "Shared" : "Updated"} profile '${name}' (${doc.entries.length} prior${doc.entries.length === 1 ? "" : "s"}) as @${auth.login}.`,
  );
  console.log(`  Link:   ${share.url}`);
  console.log(`  Import: baton profile import ${share.code}`);
  if (!share.created) console.log("The existing link now serves this version.");
  return 0;
}

async function profileShares(args: string[]): Promise<number> {
  if (args.length > 0) return usage(`profile shares takes no arguments, got '${args[0]}'.`);
  const { paths } = openScope();
  const site = siteUrl();
  const auth = requireAuth(paths.configDir, site);
  const shares = await withAuth(paths.configDir, () => listShares(site, auth.token));
  if (shares.length === 0) {
    console.log(`No shared profiles as @${auth.login}. 'baton profile share' publishes the active one.`);
    return 0;
  }
  console.log(
    table([
      ["CODE", "PROFILE", "PRIORS", "UPDATED", "LINK"],
      ...shares.map((s) => [s.code, s.name, String(s.entry_count), day(s.updated_at), s.url]),
    ]),
  );
  return 0;
}

async function profileUnshare(args: string[]): Promise<number> {
  const ref = args[0];
  if (!ref || args.length > 1) return usage("profile unshare needs: <code>");
  const share = parseShareRef(ref);
  if (!share) return usage(`'${ref}' is not a share code or link.`);
  const { paths } = openScope();
  const site = share.site ?? siteUrl();
  const auth = requireAuth(paths.configDir, site);
  await withAuth(paths.configDir, () => revokeShare(site, auth.token, share.code));
  console.log(`Revoked share ${share.code}. Its link no longer resolves.`);
  return 0;
}

async function login(args: string[]): Promise<number> {
  if (args.length > 0) return usage(`login takes no arguments, got '${args[0]}'.`);
  const { paths } = openScope();
  const site = siteUrl();
  const existing = readAuth(paths.configDir, site);
  if (existing) {
    console.log(`Already signed in to ${site} as @${existing.login}. 'baton logout' signs out.`);
    return 0;
  }
  await signIn(paths.configDir, site);
  return 0;
}

async function logout(args: string[]): Promise<number> {
  if (args.length > 0) return usage(`logout takes no arguments, got '${args[0]}'.`);
  const { paths } = openScope();
  const site = siteUrl();
  const auth = readAuth(paths.configDir, site);
  if (!auth) {
    console.log(`Not signed in to ${site}.`);
    return 0;
  }
  try {
    await revokeToken(site, auth.token);
  } catch (err) {
    // A 401 means the site already dropped it. Anything else, and forgetting
    // the token locally would leave a live credential nobody can revoke.
    if (!isUnauthorized(err)) {
      console.error(
        `Could not revoke the token on ${site}: ${message(err)}\nKept it locally so the next 'baton logout' can retry; the site's account page can revoke it too.`,
      );
      return 1;
    }
  }
  clearAuth(paths.configDir);
  console.log(`Signed out of ${site} (was @${auth.login}).`);
  return 0;
}

/** The device flow, then the token to disk. Only the token's owner can read it. */
async function signIn(configDir: string, site: string): Promise<AuthFile> {
  console.log(`Signing in to ${site} with GitHub.`);
  // A generic label: the site keeps no machine details, so not the hostname.
  const auth = await deviceLogin(site, { label: `Baton CLI on ${platformName()}` });
  const path = writeAuth(configDir, auth);
  console.log(`Signed in as @${auth.login}. Token stored in ${path}.`);
  return auth;
}

function platformName(): string {
  return process.platform === "darwin" ? "macOS" : process.platform === "linux" ? "Linux" : process.platform;
}

function requireAuth(configDir: string, site: string): AuthFile {
  const auth = readAuth(configDir, site);
  if (!auth) throw new Error(`Not signed in to ${site}. Run 'baton login' first.`);
  return auth;
}

/** A 401 means the token is dead on the site: drop it so the next call signs in fresh. */
async function withAuth<T>(configDir: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isUnauthorized(err)) {
      clearAuth(configDir);
      throw new Error(
        "The sharing site no longer accepts this token, so it was discarded. Run 'baton login' to sign in again.",
      );
    }
    throw err;
  }
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
  for (const e of diff.removed) console.log(`  - ${priorLabel(e)} (not in the document)`);
  console.log(
    `${diff.added.length} added, ${diff.changed.length} changed, ${diff.unchanged.length} unchanged, ${diff.removed.length} removed`,
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

  const db = openDb();
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
  console.log(
    `Graded run ${runId} ${score}/5 for ${run.model} via ${answering.target} (revision ${revision}).`,
  );
  return 0;
}

function set(args: string[]): number {
  const [key, value] = args;
  if (key !== SETTING_HALF_LIFE_DAYS && args.length > 2) return usage(`set takes a key and one value.`);
  if (!key || value === undefined) return usage(`set needs: <key> <value>. ${validKeys()}`);

  if (key === SETTING_MAX_HOPS) {
    const hops = parseNonNegativeInt(value, SETTING_MAX_HOPS);
    return writeSetting(key, String(hops));
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
  const db = openDb();
  const known = db
    .query<{ profile: string }, []>("SELECT DISTINCT profile FROM priors ORDER BY profile")
    .all()
    .map((r) => r.profile);
  if (!known.includes(name)) {
    return usage(
      known.length > 0
        ? `unknown profile '${name}'. Known profiles: ${known.join(", ")}.`
        : `unknown profile '${name}'. This scope has no profiles yet — seed one with the seed_ratings tool, or 'baton profile import <file>'.`,
    );
  }
  setActiveProfile(db, name);
  console.log(`${SETTING_ACTIVE_PROFILE} = ${name}`);
  return 0;
}

/** Rating settings update their revision alongside the stored value. */
function writeSetting(
  key: string,
  value: string,
  opts: { ratings?: boolean; resetEvidence?: boolean } = {},
): number {
  const db = openDb();
  if (opts.ratings) {
    setRatingSetting(db, key, value, { resetEvidence: opts.resetEvidence === true });
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

/**
 * `baton install [host...] [--user] [--dir <d>] [--no-eval]`. No host means
 * every supported host whose CLI is on PATH; `--user` writes each host's global
 * config once instead of one checkout's. Optional rating guidance is included.
 */
function install(args: string[]): number {
  const { flags, rest } = parseFlags(args, {
    value: ["dir"],
    // --with-eval is retained for older invocations; grading is now the default.
    boolean: ["with-eval", "no-eval", "user"],
  });
  if (flags["with-eval"] && flags["no-eval"]) return usage("choose either --with-eval or --no-eval");
  const scope: InstallScope = flags.user === true ? "user" : "project";
  if (scope === "user" && flags.dir !== undefined) {
    return usage("--user writes the hosts' own global configs; it takes no --dir");
  }
  for (const host of rest) {
    if (!isInstallHost(host)) {
      return usage(`unsupported host '${host}'. Supported: ${INSTALL_HOSTS.join(", ")}.`);
    }
  }
  const hosts: InstallHost[] = rest.length > 0 ? rest.filter(isInstallHost) : detectedHosts();
  if (hosts.length === 0) {
    return usage(
      `none of the supported host CLIs is on PATH (${INSTALL_HOSTS.join(", ")}); name one: baton install <host>`,
    );
  }

  const dir = flags.dir === undefined ? process.cwd() : resolve(String(flags.dir));
  const restarts = new Set<string>();
  let command = "";
  for (const host of hosts) {
    const res = installHost(host, { scope, dir, withEval: flags["no-eval"] !== true });
    command = [res.command, ...res.args].join(" ");
    console.log(`${host}: registered in ${res.mcpPath}`);
    if (res.preserved.length > 0) console.log(`  kept: ${res.preserved.join(", ")}`);
    console.log(`  skill: ${res.skillPath}`);
    if (res.migratedInstructionsPath) {
      console.log(`  removed legacy Baton instructions from ${res.migratedInstructionsPath}`);
    }
    if (res.mcpNote) console.log(`  note: ${res.mcpNote}`);
    restarts.add(res.restart);
  }
  console.log(`command: ${command}`);
  console.log(
    flags["no-eval"] === true
      ? "Instructions written without the grading section."
      : "Instructions include optional ratings and comparisons.",
  );
  for (const restart of restarts) console.log(restart);
  return 0;
}

/** `baton update`: the latest release over this binary, or a rebuild in a checkout. */
async function update(): Promise<number> {
  const res = await selfUpdate();
  if (!res.changed) {
    for (const path of refreshInstalledSkills()) console.log(`Refreshed skill: ${path}`);
    console.log(`Baton ${res.from} is up to date (latest release: ${res.to}).`);
    return 0;
  }
  // This process still has the old templates. Ask the replacement binary to refresh them.
  const refresh = Bun.spawn([res.path, "--refresh-skills"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [output, error, code] = await Promise.all([
    new Response(refresh.stdout).text(), new Response(refresh.stderr).text(), refresh.exited,
  ]);
  if (output) process.stdout.write(output);
  if (code !== 0) console.error(`baton: binary updated, but refreshing installed skills failed: ${error.trim() || `exit ${code}`}`);
  console.log(
    res.source === "release"
      ? `Updated ${res.path}: ${res.from} → ${res.to}.`
      : `Rebuilt ${res.path} from the checkout: ${res.from} → ${res.to}.`,
  );
  for (const note of res.notes) if (note) console.log(note);
  console.log("Running agent sessions keep the old server until they restart.");
  return code === 0 ? 0 : 1;
}

function usage(problem: string): number {
  console.error(`baton: ${problem}\n\n${HELP}`);
  return 2;
}

function validKeys(): string {
  return `Valid keys: ${SETTING_MAX_HOPS} <int>, ${SETTING_HALF_LIFE_DAYS} <int>, ${SETTING_PROFILE_WEIGHT} <number>, ${SETTING_ACTIVE_PROFILE} <profile>, ${SETTING_PRECIOUSNESS_PREFIX}<app>:<instance> <${Object.keys(
    PRECIOUSNESS_FACTOR,
  ).join("|")}>, ${knownApps()
    .map((app) => `${SETTING_MAX_AUTONOMY_PREFIX}${app}`)
    .join(", ")} <${AUTONOMY_ORDER.join("|")}>.`;
}

/**
 * Apps this scope can address in a setting. Built-ins always; active discovered
 * adapters too, once they are enabled — they
 * are routable, so a ceiling or a preciousness for them is exactly as meaningful
 * (the registry reads both kinds of setting generically). A `db` is only passed
 * where one is already open; the bare listing never opens a store to print help.
 */
function knownApps(db?: Database): string[] {
  const discovered = db
    ? listDiscovered(db)
        .filter((record) => record.status === "enabled")
        .map((record) => record.app)
    : [];
  return [...new Set([...builtinAdapters.map((spec) => spec.app), ...discovered])].sort();
}

function requireKnownApp(app: string, where?: string): void {
  if (getAdapter(app)) return;
  const db = openDb();
  if (knownApps(db).includes(app)) return;
  throw new UsageError(
    `unknown app '${app}'${where ? ` in '${where}'` : ""}. Known apps: ${knownApps(db).join(", ")}.`,
  );
}

function openDb(): Database {
  return openScope().db;
}

/** The database and paths for this scope. */
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
      if (inline !== undefined) throw new UsageError(`--${name} does not take a value.`);
      flags[name] = true;
      continue;
    }
    const repeats = schema.repeat?.includes(name) ?? false;
    if (!repeats && !(schema.value?.includes(name) ?? false)) {
      throw new UsageError(`unknown flag '--${name}'.`);
    }
    const value = inline ?? args[++i];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) {
      throw new UsageError(`--${name} needs a value.`);
    }
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
