import type { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { builtinAdapters, getAdapter } from "../adapters/builtin/index.ts";
import { executeAdapter, killProcessGroup } from "../adapters/executor.ts";
import {
  AUTONOMY_ORDER,
  DEFAULT_INSTANCE,
  type AdapterSpec,
  type Autonomy,
} from "../adapters/types.ts";
import { ensurePaths, resolvePaths, type BatonPaths } from "../config/paths.ts";
import {
  approveDiscovered,
  canaryDiscovered,
  CANARY_PROMPT,
  CANARY_TIMEOUT_MS,
  DIGEST_SHORT_LENGTH,
  formatReview,
  listDiscovered,
  rejectDiscovered,
  detectDiscovered,
  reviewDiscovered,
  shortDigest,
  validateSpec,
} from "../discovery/discovery.ts";
import { CANARY_TOKEN, type DiscoveredStatus } from "../discovery/types.ts";
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
import {
  diffProfileDocument,
  exportProfile,
  importProfileFile,
  parseProfileDocument,
  renderProfile,
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
import {
  addBlock,
  blockFor,
  blockReason as routeBlockReason,
  canarySlug,
  listBlocks,
  normalizePattern,
  removeBlock,
  routeKey,
  type RouteBlock,
} from "../registry/blocks.ts";
import { detectApps, listModels, routableAdapters } from "../registry/registry.ts";
import { nowIso, openStore, withBusyRetry } from "../store/store.ts";
import { createSupervisor, type Supervisor } from "../supervisor/supervisor.ts";
import {
  HOPS_ENV,
  SETTING_MAX_AUTONOMY_PREFIX,
  SETTING_MAX_CONCURRENT,
  SETTING_MAX_HOPS,
  type RunStatus,
  type RunView,
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
      case "resume":
        return await resume(args);
      case "runs":
        return runs(args);
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
        return block(args);
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
  const { db } = openScope();
  for (const app of detectApps({ probeVersion: false, db })) {
    console.log(`  ${app.app.padEnd(12)} ${app.binaryPath ?? "not on PATH in this scope"}`);
  }
  return 0;
}

function detect(): number {
  const { db } = openScope();
  // A version bump means the canary's evidence is stale, so detect is also
  // where an active discovered adapter drops out of the registry until it is
  // re-canaried (PLAN.md §Agentic discovery, step 5).
  const changes = detectDiscovered(db);
  const modelsByApp = new Map(
    routableAdapters(db).map((spec) => [spec.app, spec.models.map((m) => m.model).join(", ")]),
  );
  const rows: string[][] = [["APP", "BINARY", "VERSION", "MODELS"]];
  for (const app of detectApps({ db })) {
    rows.push([
      app.app,
      app.binaryPath ?? "(not found)",
      app.version ?? "-",
      modelsByApp.get(app.app) ?? "-",
    ]);
  }
  console.log(table(rows));
  for (const change of changes) {
    console.log(`\n${change.app}: ${change.from} → ${change.to} — ${change.note}`);
  }
  return 0;
}

function models(): number {
  const db = openDb();
  // "no" on its own sends the user hunting: the reason is the actionable half,
  // and for a blocked route it is the user's own words coming back to them.
  const rows: string[][] = [["MODEL", "ROUTE", "AVAILABLE", "MAX AUTONOMY", "WHY NOT"]];
  for (const m of listModels(db)) {
    rows.push([
      m.model,
      `${m.app}/${m.slug}`,
      m.available ? "yes" : "no",
      m.maxAutonomy,
      m.degradedReason ?? "-",
    ]);
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
  return await settle(db, supervisor, started);
}

/**
 * A second turn on a finished run's own session, on the instance that holds it
 * (PLAN.md §Session affinity — the supervisor pins both). Everything else about
 * the original request is inherited; only the prompt is new.
 */
async function resume(args: string[]): Promise<number> {
  const { flags, rest } = parseFlags(args, { value: ["timeout", "autonomy"] });
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
  return await settle(db, supervisor, started);
}

/**
 * Waits for a launched run and prints its answer. There is no --no-wait: this
 * process is the supervisor, so detaching would orphan the record. Async
 * delegation is the MCP server's job (wait:false), because that server outlives
 * the call.
 */
async function settle(
  db: Database,
  supervisor: Supervisor,
  started: { view: RunView; settled: Promise<void> },
): Promise<number> {
  const release = guardCancellation(db, supervisor, [started.view.runId]);
  try {
    await started.settled;
  } finally {
    release();
  }
  const final = supervisor.getRun(started.view.runId) ?? started.view;
  if (final.status === "succeeded") {
    console.log(final.output ?? "");
    return 0;
  }
  console.error(`baton: run ${final.runId} ${final.status}: ${final.error ?? "no error recorded"}`);
  return 1;
}

/**
 * Ctrl-C must not leave a callee's process group running: the CLI is its only
 * supervisor, and cancelRun merely SIGTERMs (its SIGKILL escalation is an
 * unref'd timer that an exiting process never fires). Cancel, wait for the
 * groups to be verifiably dead, then leave with the signal's exit code.
 * Returns the handler removal, so a finished command stops intercepting signals.
 */
function guardCancellation(db: Database, supervisor: Supervisor, runIds: string[]): () => void {
  let cancelling = false;
  const cancel = async (exitCode: number): Promise<void> => {
    if (cancelling) return; // a second Ctrl-C while the groups are dying changes nothing
    cancelling = true;
    for (const runId of runIds) supervisor.cancelRun(runId);
    const pids = runIds.flatMap((runId) => attemptPids(db, runId));
    const kills = pids.map((pid) => killProcessGroup(pid));
    for (const outcome of await Promise.all(kills)) {
      if (!outcome.dead) console.error(`baton: ${outcome.why}`);
    }
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

  // A side of an unjudged duel describes itself by label only: model, route and
  // attempt targets are exactly what `duel report` reveals (PLAN.md §Evaluation).
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
  const blind = blindRuns(db);
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

/** How an unjudged duel's side names itself everywhere a model would appear. */
function blindLabel(duelId: string): string {
  return `duel ${duelId} (blind)`;
}

/**
 * Blind A/B (PLAN.md §Evaluation). Both sides run with identical prompt,
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
    db,
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
  const { db, paths } = openScope();
  const view = reportDuel(db, duelId, winner);
  publishRatings(db, paths.configDir);
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

/**
 * The adapter surface: built-ins are pinned, discovered specs are quarantined
 * until a human approves the exact binary and argv here (PLAN.md §Agentic
 * discovery — approval precedes execution, and only the trusted CLI can give it).
 */
async function adapters(args: string[]): Promise<number> {
  switch (args[0]) {
    case "list":
      return adaptersList();
    case "review":
      return adaptersReview(args[1]);
    case "approve":
      return await adaptersApprove(args.slice(1));
    case "reject":
      return adaptersReject(args.slice(1));
    case "canary":
      return await adaptersCanary(args.slice(1));
    default:
      return usage(
        "adapters takes: list | review <app> | approve <app> --digest <digest> [--no-canary] | reject <app> [reason...] (a built-in too: it blocks every route it has) | canary <app|--all> [--structural]",
      );
  }
}

function adaptersList(): number {
  const db = openDb();
  const detected = detectedBinaries();
  const blocks = listBlocks(db);
  const rows: string[][] = [["APP", "PROVENANCE", "STATUS", "BINARY"]];
  // A built-in is pinned in the binary and cannot be un-pinned; what "rejected"
  // means for one is that the user has blocked every route it has, so the app
  // is out of service in this scope. The status column says so rather than
  // reporting a pinned adapter as though it were routable.
  const rejected: { app: string; block: RouteBlock }[] = [];
  for (const spec of builtinAdapters) {
    const block = appBlock(db, spec, blocks);
    if (block) rejected.push({ app: spec.app, block });
    rows.push([
      spec.app,
      "builtin",
      block ? "rejected" : "pinned",
      detected.get(spec.app) ?? "not on PATH in this scope",
    ]);
  }
  const discovered = listDiscovered(db);
  for (const record of discovered) {
    rows.push([record.app, "discovered", record.status, record.spec.binary]);
  }
  console.log(table(rows));

  for (const { app, block } of rejected) {
    console.log(
      `\n${app}: ${routeBlockReason(block)}. Nothing routes to it here. Restore it with: baton block remove '${block.pattern}'`,
    );
  }

  const pending = discovered.filter((r) => r.status === "quarantined").map((r) => r.app);
  if (pending.length > 0) {
    console.log(
      `\nNothing from ${pending.join(", ")} has been executed. Review before approving: baton adapters review ${pending[0]}`,
    );
  }
  return 0;
}

function adaptersReview(app: string | undefined): number {
  if (!app) return usage("adapters review needs: <app>");
  const db = openDb();
  const review = reviewDiscovered(db, app);
  if (!review) {
    console.error(
      `baton: no discovered adapter '${app}' in this scope. 'baton adapters list' shows what there is.`,
    );
    return 1;
  }
  console.log(formatReview(review));
  const digest = shortDigest(review.digest);
  console.log(
    review.needsApproval
      ? `\nApprove running this exact binary with this exact argv as '${app}'?
  approve, canary, activate:  baton adapters approve ${app} --digest ${digest}
  approve, execute nothing:   baton adapters approve ${app} --digest ${digest} --no-canary
  discard it:                 baton adapters reject ${app} [reason...]

The digest is required so that approval names the spec above and not just the app:
if the agent resubmits a different spec before you approve, the digest changes and
the approval is refused. Approval also refuses to run unless it is typed at a
terminal — which stops a stray tool call or a pasted command, not an agent that
already holds full shell access on this machine. That agent could fake a terminal;
what it cannot do is make you read a spec you never read.`
      : `\nAlready approved (${review.record.status}); 'baton adapters reject ${app}' withdraws that approval.`,
  );
  return 0;
}

/** Injected so the granting path is testable without a pty; never overridable at runtime. */
export interface ApprovalGate {
  isInteractive: () => boolean;
}

const realApprovalGate: ApprovalGate = { isInteractive: () => process.stdin.isTTY === true };

/**
 * Approval is the one place where a human, not a program, grants execution
 * rights (PLAN.md §Agentic discovery). Two conditions: the approval quotes the
 * digest of the spec stored right now — so it is a statement about content and
 * not about an app name an agent chose — and it is typed at a terminal. The
 * terminal check is not a security boundary against an agent that already has
 * full shell access here (it could fake one); it stops the accidental path, and
 * `adapters review` says so in as many words rather than implying more.
 */
export async function adaptersApprove(
  args: string[],
  gate: ApprovalGate = realApprovalGate,
): Promise<number> {
  const { flags, rest } = parseFlags(args, {
    boolean: ["canary", "no-canary"],
    value: ["digest"],
  });
  const app = rest[0];
  if (!app) return usage("adapters approve needs: <app> --digest <digest> [--no-canary]");
  const digest = typeof flags.digest === "string" ? flags.digest : undefined;
  if (!digest) {
    return usage(
      `adapters approve needs --digest <first ${DIGEST_SHORT_LENGTH} hex characters of the spec digest>. 'baton adapters review ${app}' prints it, and prints the spec you are approving.`,
    );
  }
  const db = openDb();
  const review = reviewDiscovered(db, app);
  if (!review) {
    console.error(
      `baton: no discovered adapter '${app}' in this scope. 'baton adapters list' shows what there is.`,
    );
    return 1;
  }
  if (!gate.isInteractive()) {
    console.error(
      `baton: refusing to approve '${app}': stdin is not a terminal, so nobody is here to have read the spec.`,
    );
    console.error(
      "baton: run this command yourself in a terminal. There is no override flag — approval is the only step a program is not allowed to take for you.",
    );
    return 1;
  }
  const approved = approveDiscovered(db, app, { digest });
  if (!approved.ok) {
    console.error(`baton: ${approved.errors.join("; ")}`);
    return 1;
  }
  console.log(`Approved ${app}: ${approved.record.spec.binary}`);
  // Canary by default — an approved adapter that was never executed is not yet
  // known to work, and activation is what the canary is evidence for.
  if (flags["no-canary"] === true) {
    console.log(
      `Not active yet: nothing has been executed. 'baton adapters canary ${app}' runs the canary and activates it.`,
    );
    return 0;
  }
  const canary = await canaryDiscovered(db, app);
  if (!canary.ok) {
    console.error(`baton: ${canary.errors.join("; ")}`);
    console.error(
      `baton: '${app}' stays approved but inactive — fix the spec and resubmit, or re-run 'baton adapters canary ${app}'.`,
    );
    return 1;
  }
  console.log(
    `Canary passed (${CANARY_TOKEN} extracted through the declared path) — ${app} is active.`,
  );
  return 0;
}

/**
 * Two provenances, two meanings. Rejecting a DISCOVERED adapter is a verdict on
 * a submitted spec: the quarantine store keeps it, and nothing from it ever
 * runs. A BUILT-IN has no such row — it is pinned in this binary and cannot be
 * un-pinned — so rejecting one is the user taking the whole app out of service
 * in this scope, which is precisely a route block over every route it has. Same
 * word, one mechanism each, and `adapters list` reports both as `rejected`.
 */
function adaptersReject(args: string[]): number {
  const [app, ...reason] = args;
  if (!app) return usage("adapters reject needs: <app> [reason...]");
  const db = openDb();
  const notes = reason.length > 0 ? reason.join(" ") : undefined;
  const builtin = getAdapter(app);
  if (builtin && !listDiscovered(db).some((r) => r.app === app)) {
    return rejectBuiltin(db, builtin, notes);
  }
  const rejected = rejectDiscovered(db, app, notes);
  if (!rejected.ok) {
    console.error(`baton: ${rejected.errors.join("; ")}`);
    return 1;
  }
  console.log(`Rejected ${app}. It is out of the registry and nothing from its spec runs.`);
  return 0;
}

function rejectBuiltin(db: Database, spec: AdapterSpec, reason?: string): number {
  const saved = addBlock(db, `${spec.app}:*/*`, reason);
  const routes = spec.models.map((m) => m.model).join(", ");
  console.log(
    `Rejected ${spec.app}${saved.reason ? ` (${saved.reason})` : ""}. Nothing routes to it in this scope: ${routes}.`,
  );
  console.log(
    `A built-in stays pinned in the binary — the block '${saved.pattern}' is what refuses it, including on resume and in the canary. Undo with: baton block remove '${saved.pattern}'`,
  );
  return 0;
}

/**
 * The block that takes an entire app out of service: every route of it, on
 * every instance this scope defines. A partial block steers selection and is
 * not a rejection, so it is deliberately not reported as one.
 */
function appBlock(db: Database, spec: AdapterSpec, blocks: RouteBlock[]): RouteBlock | undefined {
  const instances = [DEFAULT_INSTANCE, ...(spec.identityEnv ? instanceNames(db, spec.app) : [])];
  let first: RouteBlock | undefined;
  for (const instance of instances) {
    for (const route of spec.models) {
      const block = blockFor(blocks, spec.app, instance, route.slug);
      if (!block) return undefined;
      first ??= block;
    }
  }
  return first;
}

/**
 * The adapter conformance suite. Two checks per adapter: the same structural
 * validation the quarantine gate applies, and a live canary that asks the real
 * binary for CANARY_TOKEN and reads the answer back through the declared
 * extraction. `--all` covers the built-ins too — they are pinned, not exempt —
 * and `--structural` is the offline half, which executes nothing.
 */
async function adaptersCanary(args: string[]): Promise<number> {
  const { flags, rest } = parseFlags(args, { boolean: ["all", "structural"] });
  const app = rest[0];
  if (!app && flags.all !== true) return usage("adapters canary needs: <app> | --all [--structural]");
  const db = openDb();
  const targets = flags.all === true ? allTargets(db) : [namedTarget(db, app ?? "")];
  const live = flags.structural !== true;

  const rows: string[][] = [["APP", "PROVENANCE", "STRUCTURE", "CANARY"]];
  const details: string[] = [];
  let failed = 0;
  for (const target of targets) {
    const errors = conformanceErrors(target);
    let canary = live ? "" : "not run (--structural)";
    if (errors.length > 0) {
      failed++;
      canary = "not attempted";
      for (const error of errors) details.push(`${target.app}: ${error}`);
    } else if (live) {
      const result = await liveCanary(db, target);
      canary = result.failed ? "failed" : result.detail;
      if (result.failed) {
        failed++;
        details.push(`${target.app}: ${result.detail}`);
      }
    }
    rows.push([
      target.app,
      target.builtin ? "builtin" : target.status,
      errors.length === 0 ? "ok" : `${errors.length} error(s)`,
      canary,
    ]);
  }
  console.log(table(rows));
  for (const detail of details) console.error(`baton: ${detail}`);
  return failed === 0 ? 0 : 1;
}

interface ConformanceTarget {
  app: string;
  spec: AdapterSpec;
  builtin: boolean;
  /** Absolute path: detect-resolved for a built-in, the spec's own otherwise. */
  binaryPath: string | undefined;
  status: DiscoveredStatus | "pinned";
}

function allTargets(db: Database): ConformanceTarget[] {
  const detected = detectedBinaries();
  return [
    ...builtinAdapters.map((spec) => builtinTarget(spec, detected.get(spec.app))),
    ...listDiscovered(db).map(
      (record): ConformanceTarget => ({
        app: record.app,
        spec: record.spec,
        builtin: false,
        binaryPath: record.spec.binary,
        status: record.status,
      }),
    ),
  ];
}

function namedTarget(db: Database, app: string): ConformanceTarget {
  const record = listDiscovered(db).find((r) => r.app === app);
  if (record) {
    return {
      app,
      spec: record.spec,
      builtin: false,
      binaryPath: record.spec.binary,
      status: record.status,
    };
  }
  const spec = getAdapter(app);
  if (!spec) {
    throw new UsageError(
      `unknown adapter '${app}'. 'baton adapters list' shows the built-in and discovered ones.`,
    );
  }
  return builtinTarget(spec, detectedBinaries().get(app));
}

function builtinTarget(
  spec: AdapterSpec,
  binaryPath: string | null | undefined,
): ConformanceTarget {
  return {
    app: spec.app,
    spec,
    builtin: true,
    binaryPath: binaryPath ?? undefined,
    status: "pinned",
  };
}

/** Built-in binaries only: a discovered spec carries its own absolute path. */
function detectedBinaries(): Map<string, string | null | undefined> {
  return new Map(detectApps({ probeVersion: false }).map((a) => [a.app, a.binaryPath]));
}

/**
 * The same structural rules the quarantine gate applies. A built-in is checked
 * for shape only: the validator's other two rules are about provenance, and a
 * pinned adapter necessarily trips both (its app id "collides" with itself, its
 * `binary` is the PATH name detect resolves at run time).
 */
function conformanceErrors(target: ConformanceTarget): string[] {
  const result = validateSpec(target.spec, { builtin: target.builtin });
  return result.ok ? [] : result.errors;
}

/** Live half of the suite: burns real quota, so it is opt-in per invocation. */
async function liveCanary(
  db: Database,
  target: ConformanceTarget,
): Promise<{ failed: boolean; detail: string }> {
  if (!target.builtin) {
    const result = await canaryDiscovered(db, target.app);
    return result.ok
      ? { failed: false, detail: "passed" }
      : { failed: true, detail: result.errors.join("; ") };
  }
  // Not installed is not a conformance failure: this scope simply cannot reach
  // that app, which `detect` already reports.
  if (!target.binaryPath) return { failed: false, detail: "skipped (not on PATH)" };
  // The canary is a real call on a real subscription, so it obeys the deny
  // list: it canaries the first route the user has not blocked, and refuses
  // rather than spending one they have.
  const route = canarySlug(listBlocks(db), target.app, target.spec.models, DEFAULT_INSTANCE);
  if (route && "blocked" in route) {
    return { failed: false, detail: `skipped (${routeBlockReason(route.blocked)})` };
  }
  const slug = route?.slug;
  const autonomy = AUTONOMY_ORDER.find((level) => target.spec.autonomyFlags[level]);
  if (!slug || !autonomy) return { failed: true, detail: "declares no runnable route" };

  const result = await executeAdapter({
    spec: target.spec,
    binaryPath: target.binaryPath,
    slug,
    prompt: CANARY_PROMPT,
    cwd: process.cwd(),
    env: process.env,
    autonomy,
    timeoutMs: CANARY_TIMEOUT_MS,
  });
  const output = result.output ?? "";
  // Exact, like the discovered-adapter canary: extraction that returns the
  // token wrapped in a transcript has not been verified, it has been guessed at.
  if (result.ok && output.trim() === CANARY_TOKEN) return { failed: false, detail: "passed" };
  return {
    failed: true,
    detail: result.ok
      ? `answered ${preview(output)} instead of ${CANARY_TOKEN}`
      : (result.error ?? "failed"),
  };
}

/**
 * The stateless Streamable-HTTP face, one daemon per environment scope
 * (PLAN.md §Architecture) — a daemon inherits one environment, so it serves
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
 * Route blocks: the deny list for routes Baton can reach but must not spend
 * (PLAN.md §Registry: route blocks). Baton still does not verify identity —
 * this is the user saying which reachable routes are off limits, and Baton
 * obeying without pretending to know whose account is behind one.
 */
function block(args: string[]): number {
  const sub = args[0];
  switch (sub) {
    case "add":
      return blockAdd(args.slice(1));
    case "list":
      return blockList();
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
function blockAdd(args: string[]): number {
  const [pattern, ...reason] = args;
  if (!pattern) {
    return usage(
      "block add needs: <pattern> [reason...], e.g. baton block add 'opencode/github-copilot/*' client subscription",
    );
  }
  const db = openDb();
  const saved = addBlock(db, pattern, reason.length > 0 ? reason.join(" ") : undefined);
  console.log(`Blocked ${saved.pattern}${saved.reason ? ` (${saved.reason})` : ""}`);
  printMatches(db, saved.pattern);
  return 0;
}

function blockList(): number {
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
    rows.push([b.pattern, String(matchingRoutes(db, b.pattern).length), b.reason ?? "-"]);
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
function matchingRoutes(db: Database, pattern: string): string[] {
  const one: RouteBlock[] = [{ pattern, createdAt: "" }];
  const keys: string[] = [];
  for (const spec of routableAdapters(db)) {
    const instances = [
      DEFAULT_INSTANCE,
      ...(spec.identityEnv ? instanceNames(db, spec.app) : []),
    ];
    for (const route of spec.models) {
      for (const instance of instances) {
        if (blockFor(one, spec.app, instance, route.slug)) {
          keys.push(routeKey(spec.app, instance, route.slug));
        }
      }
    }
  }
  return keys;
}

function printMatches(db: Database, pattern: string): void {
  const matches = matchingRoutes(db, pattern);
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
 * reported separately and never merged (PLAN.md §Layering and sharing). Absent
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
  if (args[0] === "export") return profileExport(args.slice(1));
  return usage(
    "profile takes: import <file> [--name <n>] [--activate] [--yes] | export [--profile <n>] [--out <file>]",
  );
}

/**
 * Portable by construction (PLAN.md §Layering and sharing): the document is
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
  const categories = [...new Set(doc.entries.map((e) => e.category).filter(Boolean))];
  if (categories.length > 0) {
    console.log(
      `Note: category names are free text and export verbatim (${categories.join(", ")}) — check none name a client or project before sharing.`,
    );
  }
  return 0;
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
  baton resume <run-id> <prompt...>       Continue a finished run's own session
  baton runs [<run-id>]                   Recent runs, or one run in detail
  baton duel <a> <b> <prompt...>          Blind A/B; the outputs carry no names
      --category <c> --cwd <dir> --timeout <ms>
  baton duel report <duel-id> <A|B|tie>   Judge, then reveal which was which
  baton duel list                         Recent duels and their status
  baton adapters list                     Built-in and discovered adapters
  baton adapters review <app>             The exact binary, argv and env names
  baton adapters approve <app> --digest <d> [--no-canary]
  baton adapters reject <app> [reason...]  Discovered: a verdict on its spec
                                          Built-in: blocks every route it has
  baton adapters canary <app|--all> [--structural]   Conformance suite
  baton serve --http [--port <n>]         HTTP MCP daemon for this scope
  baton instance add <app> <name> --env KEY=VAL
  baton instance list
  baton instance remove <app> <name>
  baton pool set <app> <instance...>      Load-balance an app across instances
  baton pool list | pool clear <app>
  baton block add <pattern> [reason...]   Never route to <app>[:<instance>]/<slug>
      e.g. 'opencode/github-copilot/*'    ('*' wildcards; bare app blocks it all)
  baton block list | block remove <pattern>
  baton ratings [publish]                 Show ratings, or refresh ratings.yaml
  baton grade <run-id> <1-5> [notes...]   Grade a run after using its result
  baton profile import <file> [--name <n>] [--activate] [--yes]
  baton profile export [--profile <n>] [--out <file>]
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

/**
 * Apps this scope can address in a setting. Built-ins always; active discovered
 * adapters too, once a human approved them and the canary activated them — they
 * are routable, so a ceiling or a preciousness for them is exactly as meaningful
 * (the registry reads both kinds of setting generically). A `db` is only passed
 * where one is already open; the bare listing never opens a store to print help.
 */
function knownApps(db?: Database): string[] {
  const discovered = db
    ? listDiscovered(db)
        .filter((record) => record.status === "active")
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
