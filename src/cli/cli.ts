import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { builtinAdapters, getAdapter } from "../adapters/builtin/index.ts";
import { killProcessGroup } from "../adapters/executor.ts";
import { AUTONOMY_ORDER, type Autonomy } from "../adapters/types.ts";
import { ensurePaths, resolvePaths, type BatonPaths } from "../config/paths.ts";
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
import { installClaudeCode } from "./install.ts";

/**
 * The trusted face of Baton: the only place the authority ceiling and instance
 * definitions can be written (never through a tool call — PLAN.md §Execution).
 * Everything reads and writes the scope resolved from BATON_CONFIG_DIR.
 */

/**
 * Identity vars printed by `status`. Deliberately wider than the phase-1
 * adapters: status reports the environment the user is standing in, not the
 * registry, and a wrong CLAUDE_CONFIG_DIR is worth seeing before the adapter
 * that uses it exists.
 */
const IDENTITY_ENV = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "OPENCODE_CONFIG_DIR",
  "KIMI_CODE_HOME",
] as const;

const INSTALL_HOSTS = ["claude-code"];
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

  const env: Record<string, string> = {};
  for (const entry of asList(flags.env)) {
    const eq = entry.indexOf("=");
    const key = eq > 0 ? entry.slice(0, eq) : "";
    if (!key) return usage(`--env expects KEY=VALUE, got '${entry}'`);
    env[key] = expandHome(entry.slice(eq + 1));
  }
  if (Object.keys(env).length === 0) {
    return usage(
      `instance add needs at least one --env KEY=VALUE (for ${app}, typically ${spec.identityEnv ?? "its config dir var"}).`,
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
  const changes = withBusyRetry(
    () => db.query("DELETE FROM instances WHERE app = ? AND name = ?").run(app, name).changes,
  );
  if (changes === 0) {
    console.error(`baton: no instance ${app}:${name} in this scope.`);
    return 1;
  }
  console.log(`Removed instance ${app}:${name}`);
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
  if (key.startsWith(SETTING_MAX_AUTONOMY_PREFIX)) {
    const app = key.slice(SETTING_MAX_AUTONOMY_PREFIX.length);
    if (!getAdapter(app)) {
      return usage(`unknown app '${app}' in '${key}'. Known apps: ${knownApps().join(", ")}.`);
    }
    return writeSetting(key, parseAutonomy(value));
  }
  return usage(`unknown setting '${key}'. ${validKeys()}`);
}

function writeSetting(key: string, value: string): number {
  const db = openDb();
  withBusyRetry(() =>
    db
      .query(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value),
  );
  console.log(`${key} = ${value}`);
  return 0;
}

function install(args: string[]): number {
  const { flags, rest } = parseFlags(args, { value: ["dir"] });
  const host = rest[0];
  if (!host) return usage(`install needs a host: ${INSTALL_HOSTS.join(", ")}`);
  if (host !== "claude-code") {
    return usage(`unsupported host '${host}'. Supported: ${INSTALL_HOSTS.join(", ")}.`);
  }

  const target = flags.dir === undefined ? process.cwd() : resolve(String(flags.dir));
  const res = installClaudeCode(target);
  console.log(`Registered MCP server 'baton' in ${res.mcpPath}`);
  console.log(`  command: ${[res.command, ...res.args].join(" ")}`);
  if (res.preserved.length > 0) console.log(`  kept: ${res.preserved.join(", ")}`);
  console.log(`Wrote skill ${res.skillPath}`);
  console.log("Restart Claude Code in that directory to pick both up.");
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
  baton set <key> <value>                 ${validKeys()}
  baton install claude-code [--dir <dir>] Register the MCP server + skill
`);
  return 2;
}

function validKeys(): string {
  return `Valid keys: ${SETTING_MAX_HOPS} <int>, ${SETTING_MAX_CONCURRENT} <int>, ${knownApps()
    .map((app) => `${SETTING_MAX_AUTONOMY_PREFIX}${app}`)
    .join(", ")} <${AUTONOMY_ORDER.join("|")}>.`;
}

function knownApps(): string[] {
  return builtinAdapters.map((spec) => spec.app).sort();
}

function openDb(): Database {
  const paths: BatonPaths = ensurePaths(resolvePaths(process.env));
  return openStore(paths.dbPath);
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
