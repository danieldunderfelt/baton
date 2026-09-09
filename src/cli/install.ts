import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { applyEdits, modify } from "jsonc-parser";

// Bundled, not read from disk: the compiled single-file binary ships without
// the source tree, and install must work from any cwd.
import SKILL_TEMPLATE from "./templates/skill.md" with { type: "text" };
import CORE_TEMPLATE from "./templates/core.md" with { type: "text" };
import EVAL_TEMPLATE from "./templates/eval.md" with { type: "text" };

/**
 * `baton install [host...]`: register the MCP server in the host's own config
 * and install the shared skill in the host's discovery directory. Project and
 * user scopes use the same skill content. Old Baton blocks are removed from
 * AGENTS.md only after the skill and MCP registration have been written.
 *
 * Three rules hold for every host:
 * - **Merge, never replace.** Other servers and other instructions in those
 *   files are not ours; only our own entry and our own markered block move.
 * - **Atomic.** tmp + rename, so a crashed install never leaves half a file.
 * - **Two scopes, same files' shapes.** Every host reads both a project-level
 *   and a user-level config of the same format; only the paths differ.
 */

export const SERVER_NAME = "baton";

export const INSTALL_HOSTS = ["claude-code", "codex", "kimi", "opencode", "cursor-agent"] as const;
export type InstallHost = (typeof INSTALL_HOSTS)[number];

export function isInstallHost(host: string): host is InstallHost {
  return (INSTALL_HOSTS as readonly string[]).includes(host);
}

export type InstallScope = "project" | "user";

export interface InstallOptions {
  /** "project" uses `dir` and its Git root; "user" uses home config and skill directories. */
  scope?: InstallScope;
  /** Project directory; ignored for the user scope. Defaults to cwd. */
  dir?: string;
  /** Append the grading + onboarding-interview section. On unless refused. */
  withEval?: boolean;
  /** Environment to resolve home directories from. For tests. */
  env?: Record<string, string | undefined>;
}

export interface InstallResult {
  host: InstallHost;
  scope: InstallScope;
  /** Where the MCP registration landed. Every host here takes one. */
  mcpPath: string;
  /** Anything the user has to know for the registration to actually apply. */
  mcpNote?: string;
  skillPath: string;
  /** The old instruction file, when a Baton block was removed. */
  migratedInstructionsPath: string | null;
  command: string;
  args: string[];
  /** Server names already registered in that file, left untouched. */
  preserved: string[];
  restart: string;
}

interface Registration {
  mcpPath: string;
  preserved: string[];
  mcpNote?: string;
}

interface Location {
  mcpPath: string;
  skillPath: string;
  legacyInstructionsPath: string | null;
  mcpNote?: string;
}

type Env = Record<string, string | undefined>;

interface HostInstaller {
  /** Where the registration and the instructions go, per scope. */
  locate(scope: InstallScope, dir: string, env: Env): Location;
  /** The host's own MCP config format. */
  merge(path: string, command: string, args: string[]): Registration;
  restart: string;
}

const AGENTS_FILE = "AGENTS.md";

function home(env: Env): string {
  return env.HOME || homedir();
}

/**
 * The user scope is the host's own global config: the place its docs say a
 * machine-wide MCP server lives, honouring the host's env overrides. Skills
 * use the shared home directory, except for Claude's own skill directory.
 */
const HOSTS: Record<InstallHost, HostInstaller> = {
  "claude-code": {
    locate: (scope, dir, env) => {
      if (scope === "project") {
        return {
          mcpPath: join(dir, ".mcp.json"),
          skillPath: join(dir, ".claude", "skills", SERVER_NAME, "SKILL.md"),
          legacyInstructionsPath: null,
        };
      }
      const config = env.CLAUDE_CONFIG_DIR || join(home(env), ".claude");
      return {
        mcpPath: join(env.CLAUDE_CONFIG_DIR || home(env), ".claude.json"),
        skillPath: join(config, "skills", SERVER_NAME, "SKILL.md"),
        legacyInstructionsPath: null,
      };
    },
    merge: mergeMcpJson,
    restart: "Restart Claude Code to pick both up.",
  },
  codex: {
    locate: (scope, dir, env) => {
      if (scope === "project") {
        return {
          mcpPath: join(dir, ".codex", "config.toml"),
          skillPath: sharedSkillPath(scope, dir, env),
          legacyInstructionsPath: join(dir, AGENTS_FILE),
          mcpNote: `Codex applies a project's .codex/config.toml only to trusted projects: accept the trust prompt on first run in ${dir}, or add projects."${dir}".trust_level = "trusted" to ~/.codex/config.toml.`,
        };
      }
      const config = env.CODEX_HOME || join(home(env), ".codex");
      return {
        mcpPath: join(config, "config.toml"),
        skillPath: sharedSkillPath(scope, dir, env),
        legacyInstructionsPath: join(config, AGENTS_FILE),
      };
    },
    merge: mergeCodexToml,
    restart: "Start a new codex session to pick both up.",
  },
  kimi: {
    locate: (scope, dir, env) => {
      if (scope === "project") return locateKimiProject(dir, env);
      const config = env.KIMI_CODE_HOME || join(home(env), ".kimi-code");
      return {
        mcpPath: join(config, "mcp.json"),
        skillPath: sharedSkillPath(scope, dir, env),
        legacyInstructionsPath: join(config, AGENTS_FILE),
      };
    },
    merge: mergeMcpJson,
    restart: "MCP servers load at session start: start a new kimi session.",
  },
  opencode: {
    locate: (scope, dir, env) => {
      if (scope === "project") {
        return {
          mcpPath: opencodeConfig(dir),
          skillPath: sharedSkillPath(scope, dir, env),
          legacyInstructionsPath: join(dir, AGENTS_FILE),
        };
      }
      const config = join(env.XDG_CONFIG_HOME || join(home(env), ".config"), "opencode");
      return {
        mcpPath: env.OPENCODE_CONFIG ? resolve(env.OPENCODE_CONFIG) : opencodeConfig(config),
        skillPath: sharedSkillPath(scope, dir, env),
        legacyInstructionsPath: join(config, AGENTS_FILE),
      };
    },
    merge: mergeOpencodeJson,
    restart: "Start a new opencode session to pick both up.",
  },
  "cursor-agent": {
    locate: (scope, dir, env) => {
      const config = join(scope === "project" ? dir : home(env), ".cursor");
      return {
        mcpPath: join(config, "mcp.json"),
        skillPath: sharedSkillPath(scope, dir, env),
        legacyInstructionsPath: scope === "project" ? join(dir, AGENTS_FILE) : null,
        mcpNote:
          "Approve Baton when Cursor prompts, or enable it with 'cursor-agent mcp enable baton'.",
      };
    },
    merge: mergeMcpJson,
    restart: "Start a new Cursor Agent session to pick both up.",
  },
};

/** One copy serves Codex, Kimi, OpenCode and Cursor, even with relocated app configs. */
function sharedSkillPath(scope: InstallScope, dir: string, env: Env): string {
  const root = scope === "user" ? home(env) : projectRoot(dir);
  return join(root, ".agents", "skills", SERVER_NAME, "SKILL.md");
}

function opencodeConfig(dir: string): string {
  const jsonc = join(dir, "opencode.jsonc");
  return existsSync(jsonc) ? jsonc : join(dir, "opencode.json");
}

/** The host CLIs on PATH: what a bare `baton install` registers with. */
export function detectedHosts(env: Env = process.env): InstallHost[] {
  const binary: Record<InstallHost, string> = {
    "claude-code": "claude",
    codex: "codex",
    kimi: "kimi",
    opencode: "opencode",
    "cursor-agent": "cursor-agent",
  };
  return INSTALL_HOSTS.filter((host) => Bun.which(binary[host], { PATH: env.PATH ?? "" }) !== null);
}

export function installHost(host: InstallHost, opts: InstallOptions = {}): InstallResult {
  const scope = opts.scope ?? "project";
  const env = opts.env ?? process.env;
  const dir = resolve(opts.dir ?? process.cwd());
  if (scope === "project" && !existsSync(dir)) {
    throw new Error(`Target directory does not exist: ${dir}`);
  }

  const installer = HOSTS[host];
  const { command, args } = serverCommand();
  const location = installer.locate(scope, dir, env);
  const body = skillText(opts.withEval ?? true);
  const legacy = legacyCleanup(location.legacyInstructionsPath);
  mkdirSync(dirname(location.mcpPath), { recursive: true });
  const registration = installer.merge(location.mcpPath, command, args);
  mkdirSync(dirname(location.skillPath), { recursive: true });
  atomicWrite(location.skillPath, body);
  if (legacy) {
    if (legacy.content === "" && !lstatSync(legacy.path).isSymbolicLink()) unlinkSync(legacy.path);
    else atomicWrite(legacy.path, legacy.content);
  }

  return {
    host,
    scope,
    ...registration,
    ...(location.mcpNote ? { mcpNote: location.mcpNote } : {}),
    skillPath: location.skillPath,
    migratedInstructionsPath: legacy?.path ?? null,
    command,
    args,
    restart: installer.restart,
  };
}

/**
 * All hosts load the same skill, with the optional grading section appended.
 */
export function skillText(withEval: boolean): string {
  if (!SKILL_TEMPLATE.includes(CORE_PLACEHOLDER)) {
    throw new Error(`The skill template lost its ${CORE_PLACEHOLDER} placeholder.`);
  }
  const body = SKILL_TEMPLATE.replace(CORE_PLACEHOLDER, CORE_TEMPLATE.trim()).trimEnd();
  return withEval ? `${body}\n\n${EVAL_TEMPLATE.trimEnd()}\n` : `${body}\n`;
}

const CORE_PLACEHOLDER = "{core}";

/**
 * How the host should launch Baton. A compiled binary is self-contained and
 * needs no runtime; otherwise the host runs this checkout's entry through bun.
 * Both paths are absolute: the host's cwd is not ours.
 */
function serverCommand(): { command: string; args: string[] } {
  // A compiled binary runs from a virtual filesystem root: it has no source
  // tree beside it, and it is itself the thing the host should launch.
  if (import.meta.dir.startsWith("/$bunfs") || import.meta.dir.startsWith("B:\\~BUN")) {
    return { command: process.execPath, args: ["mcp"] };
  }
  const root = resolve(import.meta.dir, "..", "..");
  return { command: process.execPath, args: ["run", join(root, "src", "index.ts"), "mcp"] };
}

/** Claude Code, Kimi and Cursor: `mcpServers.<name>` in an `.mcp.json`-shaped file. */
function mergeMcpJson(path: string, command: string, args: string[]): Registration {
  const doc = readJsonObject(path);
  const servers = serverEntries(doc, "mcpServers", path);
  const preserved = Object.keys(servers).filter((name) => name !== SERVER_NAME);
  servers[SERVER_NAME] = { command, args };
  doc.mcpServers = servers;
  atomicWrite(path, `${JSON.stringify(doc, null, 2)}\n`);
  return { mcpPath: path, preserved };
}

/**
 * Kimi Code loads three MCP files (verified against the shipped binary's
 * `resolveMcpJsonPaths`/`findProjectRoot`): the user-global one, the
 * Claude-compatible `<project root>/.mcp.json` — where the project root is the
 * nearest `.git` ancestor of the *session's* cwd — and `<cwd>/.kimi-code/mcp.json`,
 * which wins on a name collision.
 *
 * So the shared root file only reaches Kimi when the target directory really is
 * the repository root. Installing into a subdirectory of a checkout writes a
 * `.mcp.json` Kimi resolves past and never reads; there the Kimi-specific
 * project-local file is the one that loads, so that is where the registration
 * goes.
 */
function locateKimiProject(dir: string, env: Env): Location {
  const skillPath = sharedSkillPath("project", dir, env);
  const legacyInstructionsPath = join(dir, AGENTS_FILE);
  if (existsSync(join(dir, ".git"))) {
    return {
      mcpPath: join(dir, ".mcp.json"),
      skillPath,
      legacyInstructionsPath,
      mcpNote:
        "Kimi Code reads the project-root .mcp.json (the Claude-compatible file), so this one registration serves both hosts.",
    };
  }
  return {
    mcpPath: join(dir, ".kimi-code", "mcp.json"),
    skillPath,
    legacyInstructionsPath,
    mcpNote: `${dir} is not a repository root, so Kimi Code would look for the Claude-compatible .mcp.json somewhere else entirely; this went to Kimi's own project-local file, which loads for sessions started in ${dir}. Re-run the install at the repository root to register once for both hosts.`,
  };
}

/** Kimi discovers project skills at the nearest Git root, or cwd without one. */
function projectRoot(dir: string): string {
  for (let candidate = dir; ; candidate = dirname(candidate)) {
    if (existsSync(join(candidate, ".git"))) return candidate;
    if (dirname(candidate) === candidate) return dir;
  }
}

/**
 * opencode: `mcp.<name>` (not `mcpServers`), with a `type` discriminator and
 * command-as-array. `opencode mcp add` cannot script a stdio server (it has no
 * --command flag), so the JSON is merged directly.
 */
function mergeOpencodeJson(path: string, command: string, args: string[]): Registration {
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "{}";
  const doc: unknown = Bun.JSONC.parse(raw.trim() || "{}");
  if (!isRecord(doc)) throw new Error(`${path} must contain a JSON object.`);
  const servers = serverEntries(doc, "mcp", path);
  const preserved = Object.keys(servers).filter((name) => name !== SERVER_NAME);
  const indentation = raw.match(/^[\t ]+(?=")/m)?.[0] ?? "  ";
  const formattingOptions = {
    insertSpaces: !indentation.includes("\t"),
    tabSize: indentation.length,
  };
  let output = raw.trim() || "{}";
  if (doc.$schema === undefined) {
    output = applyEdits(
      output,
      modify(output, ["$schema"], "https://opencode.ai/config.json", { formattingOptions }),
    );
  }
  output = applyEdits(
    output,
    modify(
      output,
      ["mcp", SERVER_NAME],
      { type: "local", command: [command, ...args], enabled: true },
      { formattingOptions },
    ),
  );
  atomicWrite(path, `${output.trimEnd()}\n`);
  return { mcpPath: path, preserved };
}

/**
 * codex: `[mcp_servers.<name>]` in the project `.codex/config.toml`. `codex mcp
 * add` has no scope flag and always writes the user-level config, so a
 * project-scoped registration has to be merged by hand.
 *
 * The merge is textual and deliberately narrow: everything outside our own
 * table is copied verbatim, including comments and formatting, and only
 * `[mcp_servers.baton]` (with its sub-tables) is replaced. TOML forbids
 * defining the same table twice, so a `mcp_servers` written in any shape this
 * merge cannot replace in place — an inline table, or dotted keys like
 * `mcp_servers.baton.command = "…"` — is refused rather than appended to,
 * which would leave codex with a config it rejects wholesale.
 */
function mergeCodexToml(path: string, command: string, args: string[]): Registration {
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  const original = Bun.TOML.parse(raw);

  const kept: string[] = [];
  const preserved = new Set<string>();
  // null = a header shape we do not parse (an array of tables), so keys under
  // it are not ours to reason about.
  let table: string[] | null = [];
  let dropping = false;
  for (const line of raw.split("\n")) {
    const header = tableHeader(line);
    if (header) {
      const name = header[1];
      table = header;
      dropping = header[0] === "mcp_servers" && name === SERVER_NAME;
      if (header[0] === "mcp_servers" && name !== undefined && name !== SERVER_NAME) {
        preserved.add(name);
      }
    } else if (line.trim().startsWith("[")) {
      table = null; // An array-of-tables or a shape we do not parse: keep it.
      dropping = false;
    } else if (!dropping && table !== null) {
      const key = keyPath(line);
      if (key) noteOrRefuse(path, table, key, preserved);
    }
    if (!dropping) kept.push(line);
  }

  const before = kept.join("\n").replace(/\n+$/, "");
  const block = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(command)}`,
    `args = [${args.map(tomlString).join(", ")}]`,
    "enabled = true",
  ].join("\n");
  const output = before ? `${before}\n\n${block}\n` : `${block}\n`;
  // Validate the real TOML before touching disk. The textual merge preserves
  // comments, but must never reinterpret a multiline string as a table.
  const updated = Bun.TOML.parse(output);
  const withoutBaton = (doc: unknown): Record<string, unknown> => {
    if (!isRecord(doc)) throw new Error(`${path} must contain a TOML table.`);
    const result = { ...doc };
    if (isRecord(result.mcp_servers)) {
      const servers = { ...result.mcp_servers };
      delete servers[SERVER_NAME];
      if (Object.keys(servers).length === 0) delete result.mcp_servers;
      else result.mcp_servers = servers;
    }
    return result;
  };
  if (!isDeepStrictEqual(withoutBaton(original), withoutBaton(updated))) {
    throw new Error(
      `Cannot merge ${path} without changing unrelated TOML values; nothing was written.`,
    );
  }
  atomicWrite(path, output);
  return { mcpPath: path, preserved: [...preserved].sort() };
}

const TABLE_HEADER = /^\[\s*([^[\]]+?)\s*\]\s*(?:#.*)?$/;
const SEGMENT = String.raw`(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')`;
const KEY_ASSIGNMENT = new RegExp(String.raw`^\s*(${SEGMENT}(?:\s*\.\s*${SEGMENT})*)\s*=`);

/** Dotted key path of a `[a.b.c]` header line, or null if the line is not one. */
function tableHeader(line: string): string[] | null {
  const match = TABLE_HEADER.exec(line.trim());
  if (!match) return null;
  return dottedPath(match[1]!);
}

/** Key path a `a.b = value` line assigns to, relative to its table, or null. */
function keyPath(line: string): string[] | null {
  const match = KEY_ASSIGNMENT.exec(line);
  return match ? dottedPath(match[1]!) : null;
}

function dottedPath(dotted: string): string[] {
  return (dotted.match(new RegExp(SEGMENT, "g")) ?? []).map((part) => {
    const segment = part.trim();
    return segment.startsWith('"') || segment.startsWith("'") ? segment.slice(1, -1) : segment;
  });
}

/**
 * A key line inside a table we understand. Another server declared under an
 * explicit `[mcp_servers]` header is a sibling our appended table can live
 * beside, so it is only noted. Everything else that roots at `mcp_servers` —
 * the whole table inline, dotted keys at the top level, or our own entry
 * written as `mcp_servers.baton.command = "…"` — puts a definition where
 * appending `[mcp_servers.baton]` would define the same table twice, which
 * codex rejects by refusing the entire file. Those stop the install with the
 * file untouched; TOML this shape needs a hand, and we have no parser to do it.
 */
function noteOrRefuse(path: string, table: string[], key: string[], preserved: Set<string>): void {
  const full = [...table, ...key];
  if (full[0] !== "mcp_servers") return;
  const entry = full[1];
  if (table.length > 0 && entry !== undefined && entry !== SERVER_NAME) {
    preserved.add(entry);
    return;
  }
  const shape =
    full.length === 1
      ? "declares mcp_servers as an inline table"
      : `defines ${full.join(".")} outside [mcp_servers.<name>] table syntax`;
  throw new Error(
    `${path} ${shape}. Appending [mcp_servers.${SERVER_NAME}] would define mcp_servers${entry === undefined ? "" : `.${entry}`} twice and codex would refuse the whole file, so nothing was changed. Rewrite that entry as a [mcp_servers.<name>] table (or remove it) and re-run the install.`,
  );
}

/** TOML basic strings take JSON escapes, so JSON quoting is exact here. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Prepare migration before writing any files. Only complete, standalone Baton
 * marker pairs belong to us; surrounding bytes and symlinks are preserved.
 */
function legacyCleanup(path: string | null): { path: string; content: string } | undefined {
  if (!path || !existsSync(path)) return undefined;
  const existing = readFileSync(path, "utf8");
  let inside = false;
  let cursor = 0;
  let content = "";
  for (const marker of existing.matchAll(/^<!-- baton:(begin|end) -->\r?$/gm)) {
    const begins = marker[1] === "begin";
    if (begins === inside) {
      throw new Error(
        `${path} has unmatched or nested Baton markers; repair the block before installing, refusing to guess.`,
      );
    }
    if (begins) content += existing.slice(cursor, marker.index);
    else {
      cursor = marker.index + marker[0].length;
      if (existing[cursor] === "\n") cursor++;
    }
    inside = begins;
  }
  if (inside)
    throw new Error(
      `${path} has an unfinished Baton block; repair it before installing, refusing to guess.`,
    );
  if (cursor === 0) return undefined;
  return { path, content: content + existing.slice(cursor) };
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}). Fix or remove it; refusing to overwrite a file we cannot merge.`,
    );
  }
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object.`);
  return { ...parsed };
}

function atomicWrite(path: string, content: string): void {
  if (existsSync(path)) path = realpathSync(path);
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
    writeFileSync(tmp, content, { mode, flag: "wx" });
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing to clean up.
    }
    throw err;
  }
}

function serverEntries(
  doc: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, unknown> {
  const value = doc[key];
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${path}: ${key} must be an object; nothing was written.`);
  return { ...value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
