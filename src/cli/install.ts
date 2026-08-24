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
import SKILL_TEMPLATE from "./templates/claude-code-skill.md" with { type: "text" };

/**
 * `baton install claude-code`: register the MCP server in the project's
 * .mcp.json and render the instruction layer as a skill (PLAN.md §Installers).
 * Both writes are tmp+rename so a crashed install never leaves a half file,
 * and .mcp.json is merged: other servers in the host's config are not ours.
 */

export const SERVER_NAME = "baton";

export interface InstallResult {
  mcpPath: string;
  skillPath: string;
  command: string;
  args: string[];
  /** Server names already in .mcp.json that were left untouched. */
  preserved: string[];
}

export function installClaudeCode(targetDir: string): InstallResult {
  const dir = resolve(targetDir);
  if (!existsSync(dir)) throw new Error(`Target directory does not exist: ${dir}`);

  const { command, args } = serverCommand();
  const mcpPath = join(dir, ".mcp.json");
  const doc = readMcpJson(mcpPath);
  const servers = isRecord(doc.mcpServers) ? { ...doc.mcpServers } : {};
  const preserved = Object.keys(servers).filter((name) => name !== SERVER_NAME);
  servers[SERVER_NAME] = { command, args };
  doc.mcpServers = servers;
  atomicWrite(mcpPath, `${JSON.stringify(doc, null, 2)}\n`);

  const skillPath = join(dir, ".claude", "skills", SERVER_NAME, "SKILL.md");
  mkdirSync(dirname(skillPath), { recursive: true });
  atomicWrite(skillPath, SKILL_TEMPLATE);

  return { mcpPath, skillPath, command, args, preserved };
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
  const compiled = join(root, "dist", "baton");
  if (existsSync(compiled)) return { command: compiled, args: ["mcp"] };
  return { command: "bun", args: ["run", join(root, "src", "index.ts"), "mcp"] };
}

function readMcpJson(path: string): Record<string, unknown> {
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
