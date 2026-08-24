import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

// Bundled, not read from disk: the compiled single-file binary ships without
// the source tree, and install must work from any cwd.
import EVAL_TEMPLATE from "./templates/eval.md" with { type: "text" };
import INSTRUCTIONS_TEMPLATE from "./templates/instructions.md" with { type: "text" };
import SKILL_FRONTMATTER from "./templates/skill-frontmatter.md" with { type: "text" };

/**
 * `baton install <host>` (PLAN.md §Installers): register the MCP server in the
 * host's own config and render the instruction layer in the host's dialect —
 * a skill for Claude Code, a markered `AGENTS.md` block for the AGENTS.md
 * family. One instruction text, host-parameterised: what the agent needs to
 * know about delegating does not change per host.
 *
 * Three rules hold for every host:
 * - **Merge, never replace.** Other servers and other instructions in those
 *   files are not ours; only our own entry and our own markered block move.
 * - **Atomic.** tmp + rename, so a crashed install never leaves half a file.
 * - **Project scope where the host has one.** Every host here reads a
 *   project-level config, which keeps a Baton install scoped to a checkout
 *   instead of the user's whole machine.
 */

export const SERVER_NAME = "baton";

export const INSTALL_HOSTS = ["claude-code", "codex", "kimi", "opencode"] as const;
export type InstallHost = (typeof INSTALL_HOSTS)[number];

export function isInstallHost(host: string): host is InstallHost {
  return (INSTALL_HOSTS as readonly string[]).includes(host);
}

export interface InstallOptions {
  /** Append the grading + onboarding-interview section (PLAN.md: eval is opt-in). */
  withEval?: boolean;
}

export interface InstallResult {
  host: InstallHost;
  /** Where the MCP registration landed. Every host here takes one. */
  mcpPath: string;
  /** Anything the user has to know for the registration to actually apply. */
  mcpNote?: string;
  /** File carrying the instruction layer. */
  instructionsPath: string;
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

interface HostInstaller {
  register(dir: string, command: string, args: string[]): Registration;
  writeInstructions(dir: string, body: string): string;
  restart: string;
}

const AGENTS_FILE = "AGENTS.md";

const HOSTS: Record<InstallHost, HostInstaller> = {
  "claude-code": {
    register: (dir, command, args) => mergeMcpJson(join(dir, ".mcp.json"), command, args),
    writeInstructions: (dir, body) => {
      const path = join(dir, ".claude", "skills", SERVER_NAME, "SKILL.md");
      mkdirSync(dirname(path), { recursive: true });
      atomicWrite(path, `${SKILL_FRONTMATTER.trimEnd()}\n\n${body}`);
      return path;
    },
    restart: "Restart Claude Code in that directory to pick both up.",
  },
  codex: {
    register: (dir, command, args) => ({
      ...mergeCodexToml(join(dir, ".codex", "config.toml"), command, args),
      mcpNote: `Codex applies a project's .codex/config.toml only to trusted projects: accept the trust prompt on first run in ${dir}, or add projects."${dir}".trust_level = "trusted" to ~/.codex/config.toml.`,
    }),
    writeInstructions: (dir, body) => writeMarkedBlock(join(dir, AGENTS_FILE), body),
    restart: "Start a new codex session in that directory to pick both up.",
  },
  kimi: {
    register: (dir, command, args) => registerKimi(dir, command, args),
    writeInstructions: (dir, body) => writeMarkedBlock(join(dir, AGENTS_FILE), body),
    restart: "MCP servers load at session start: start a new kimi session in that directory.",
  },
  opencode: {
    register: (dir, command, args) => mergeOpencodeJson(join(dir, "opencode.json"), command, args),
    writeInstructions: (dir, body) => writeMarkedBlock(join(dir, AGENTS_FILE), body),
    restart: "Start a new opencode session in that directory to pick both up.",
  },
};

export function installHost(
  host: InstallHost,
  targetDir: string,
  opts: InstallOptions = {},
): InstallResult {
  const dir = resolve(targetDir);
  if (!existsSync(dir)) throw new Error(`Target directory does not exist: ${dir}`);

  const installer = HOSTS[host];
  const { command, args } = serverCommand();
  const registration = installer.register(dir, command, args);
  const body = instructionText(opts.withEval ?? false);
  const instructionsPath = installer.writeInstructions(dir, body);

  return {
    host,
    ...registration,
    instructionsPath,
    command,
    args,
    restart: installer.restart,
  };
}

/** The instruction layer, with the opt-in eval section appended. */
export function instructionText(withEval: boolean): string {
  const body = INSTRUCTIONS_TEMPLATE.trimEnd();
  return withEval ? `${body}\n\n${EVAL_TEMPLATE.trimEnd()}\n` : `${body}\n`;
}

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
  const compiled = join(root, "dist", SERVER_NAME);
  if (existsSync(compiled)) return { command: compiled, args: ["mcp"] };
  return { command: "bun", args: ["run", join(root, "src", "index.ts"), "mcp"] };
}

/** Claude Code and Kimi Code: `mcpServers.<name>` in the project `.mcp.json`. */
function mergeMcpJson(path: string, command: string, args: string[]): Registration {
  const doc = readJsonObject(path);
  const servers = isRecord(doc.mcpServers) ? { ...doc.mcpServers } : {};
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
function registerKimi(dir: string, command: string, args: string[]): Registration {
  if (existsSync(join(dir, ".git"))) {
    return {
      ...mergeMcpJson(join(dir, ".mcp.json"), command, args),
      mcpNote:
        "Kimi Code reads the project-root .mcp.json (the Claude-compatible file), so this one registration serves both hosts.",
    };
  }
  const path = join(dir, ".kimi-code", "mcp.json");
  mkdirSync(dirname(path), { recursive: true });
  return {
    ...mergeMcpJson(path, command, args),
    mcpNote: `${dir} is not a repository root, so Kimi Code would look for the Claude-compatible .mcp.json somewhere else entirely; this went to Kimi's own project-local file, which loads for sessions started in ${dir}. Re-run the install at the repository root to register once for both hosts.`,
  };
}

/**
 * opencode: `mcp.<name>` (not `mcpServers`), with a `type` discriminator and
 * command-as-array. `opencode mcp add` cannot script a stdio server (it has no
 * --command flag), so the JSON is merged directly.
 */
function mergeOpencodeJson(path: string, command: string, args: string[]): Registration {
  const doc = readJsonObject(path);
  if (doc.$schema === undefined) doc.$schema = "https://opencode.ai/config.json";
  const servers = isRecord(doc.mcp) ? { ...doc.mcp } : {};
  const preserved = Object.keys(servers).filter((name) => name !== SERVER_NAME);
  servers[SERVER_NAME] = { type: "local", command: [command, ...args], enabled: true };
  doc.mcp = servers;
  atomicWrite(path, `${JSON.stringify(doc, null, 2)}\n`);
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
  mkdirSync(dirname(path), { recursive: true });
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";

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
  atomicWrite(path, before ? `${before}\n\n${block}\n` : `${block}\n`);
  return { mcpPath: path, preserved: [...preserved].sort() };
}

const TABLE_HEADER = /^\[\s*([^[\]]+?)\s*\]$/;
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
  return dotted.split(".").map((part) => {
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

export const BLOCK_BEGIN = `<!-- ${SERVER_NAME}:begin -->`;
export const BLOCK_END = `<!-- ${SERVER_NAME}:end -->`;

/**
 * The AGENTS.md dialect: our instructions live between HTML-comment markers and
 * everything else in the file is opaque — those hosts read the whole file, and
 * the user's own instructions are the reason it exists. Re-running replaces the
 * block in place; a file with a begin marker and no end marker is a corruption
 * we refuse to guess at.
 */
export function writeMarkedBlock(path: string, body: string): string {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const block = `${BLOCK_BEGIN}\n${body.trim()}\n${BLOCK_END}\n`;
  const start = existing.indexOf(BLOCK_BEGIN);
  const end = existing.indexOf(BLOCK_END);
  if (start === -1) {
    const before = existing.replace(/\s+$/, "");
    atomicWrite(path, before ? `${before}\n\n${block}` : block);
    return path;
  }
  if (end < start) {
    throw new Error(
      `${path} has a ${BLOCK_BEGIN} marker without a matching ${BLOCK_END} after it. Repair or remove the block; refusing to guess where it ends.`,
    );
  }
  const after = existing.slice(end + BLOCK_END.length).replace(/^\n/, "");
  atomicWrite(path, `${existing.slice(0, start)}${block}${after}`);
  return path;
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
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    writeFileSync(tmp, content, { mode: 0o644 });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
