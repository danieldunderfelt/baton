import { chmodSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Where Baton keeps its world. `BATON_CONFIG_DIR` relocates everything —
 * config and state — which is the whole scope-partitioning mechanism:
 * a direnv scope with its own BATON_CONFIG_DIR has its own instances,
 * settings, and database, and cannot see any other scope's.
 */
export interface BatonPaths {
  /** Human-readable config (settings.json, instances). */
  configDir: string;
  /** Mutable state (SQLite DB). */
  dataDir: string;
  dbPath: string;
  /** True when BATON_CONFIG_DIR partitions this scope. */
  scoped: boolean;
}

export function resolvePaths(env: Record<string, string | undefined> = Bun.env): BatonPaths {
  const scope = env.BATON_CONFIG_DIR;
  if (scope) {
    // Absolutised against cwd: a relative BATON_CONFIG_DIR would otherwise give
    // the CLI and the MCP server different databases for the same scope.
    const root = resolve(expandHome(scope, env));
    return {
      configDir: root,
      dataDir: join(root, "state"),
      dbPath: join(root, "state", "baton.db"),
      scoped: true,
    };
  }
  const configDir = join(env.XDG_CONFIG_HOME ?? join(home(env), ".config"), "baton");
  const dataDir = join(env.XDG_DATA_HOME ?? join(home(env), ".local", "share"), "baton");
  return { configDir, dataDir, dbPath: join(dataDir, "baton.db"), scoped: false };
}

/** Creates config/data dirs with 0700 perms. Idempotent. */
export function ensurePaths(p: BatonPaths): BatonPaths {
  ensureDir(p.configDir);
  ensureDir(p.dataDir);
  return p;
}

/**
 * mkdir's `mode` only applies to directories it creates, so a pre-existing
 * 0755 scope dir would stay world-readable — prompts live in there. chmod
 * unconditionally.
 */
function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!statSync(dir).isDirectory()) throw new Error(`Baton path is not a directory: ${dir}`);
  chmodSync(dir, 0o700);
}

function home(env: Record<string, string | undefined>): string {
  return env.HOME ?? homedir();
}

function expandHome(p: string, env: Record<string, string | undefined>): string {
  if (p === "~") return home(env);
  if (p.startsWith("~/")) return join(home(env), p.slice(2));
  return p;
}
