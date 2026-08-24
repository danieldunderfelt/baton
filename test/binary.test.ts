import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The phase-1 compiled-binary smoke test (PLAN.md §Architecture): a
 * `bun build --compile` executable has no source tree, no bun runtime and no
 * cwd it can rely on, so external SQLite, child-process spawning and packaged
 * templates all have to be checked against the real artifact.
 *
 * Guarded on the binary existing — `bun run build` produces it; the suite must
 * not fail on a fresh checkout that has not built yet.
 */

const BINARY = resolve(import.meta.dir, "..", "dist", "baton");
const BUILT = existsSync(BINARY);

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function scope(): string {
  const dir = mkdtempSync(join(tmpdir(), "baton-bin-"));
  dirs.push(dir);
  return dir;
}

/** Every invocation runs in its own scope, from a cwd that is not the repo. */
async function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = scope();
  const proc = Bun.spawn([BINARY, ...args], {
    cwd: dir,
    env: { ...process.env, BATON_CONFIG_DIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe.skipIf(!BUILT)("compiled binary", () => {
  test("--version prints the package version", async () => {
    const { code, stdout } = await run("--version");
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("status reports the scope it was pointed at", async () => {
    const dir = scope();
    const proc = Bun.spawn([BINARY, "status"], {
      cwd: dir,
      env: { ...process.env, BATON_CONFIG_DIR: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain("BATON_CONFIG_DIR");
    expect(stdout).toContain(dir);
    expect(stdout).toContain("adapters:");
  });

  test("detect probes the installed CLIs", async () => {
    const { code, stdout } = await run("detect");
    expect(code).toBe(0);
    expect(stdout).toContain("APP");
    expect(stdout).toContain("codex");
    expect(stdout).toContain("kimi");
  });

  test("models lists the built-in routes from a fresh scope database", async () => {
    const { code, stdout } = await run("models");
    expect(code).toBe(0);
    expect(stdout).toContain("kimi-k3");
    expect(stdout).toContain("gpt-5.6-sol");
  });

  test("the scope database is created outside the binary and survives it", async () => {
    const dir = scope();
    const proc = Bun.spawn([BINARY, "runs"], {
      cwd: dir,
      env: { ...process.env, BATON_CONFIG_DIR: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    expect(existsSync(join(dir, "state", "baton.db"))).toBe(true);
  });

  test("install writes the bundled skill and registers the binary itself", async () => {
    const target = scope();
    const { code, stdout } = await run("install", "claude-code", "--dir", target);
    expect(code, stdout).toBe(0);

    const mcp = JSON.parse(readFileSync(join(target, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    // The compiled binary has no source tree to point a host at: it registers itself.
    expect(mcp.mcpServers.baton?.command).toBe(BINARY);
    expect(mcp.mcpServers.baton?.args).toEqual(["mcp"]);

    // The template is embedded in the executable, not read from disk at runtime.
    const skill = readFileSync(join(target, ".claude", "skills", "baton", "SKILL.md"), "utf8");
    expect(skill).toContain("name: baton");
    expect(skill).toContain("run_model");
  });

  test("serves MCP over stdio to a real SDK client", async () => {
    const dir = scope();
    const env: Record<string, string> = { BATON_CONFIG_DIR: dir, BATON_HOPS: "0" };
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !(key in env)) env[key] = value;
    }
    const client = new Client({ name: "baton-binary-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({ command: BINARY, args: ["mcp"], env, cwd: dir, stderr: "pipe" }),
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["get_run", "list_models", "run_model"]);

      const res = await client.callTool({ name: "list_models", arguments: {} });
      const first = Array.isArray(res.content) ? res.content[0] : undefined;
      const payload = JSON.parse(first && first.type === "text" ? first.text : "{}") as {
        scope: { scoped: boolean; configDir: string };
        models: { model: string }[];
      };
      expect(payload.scope).toEqual({ scoped: true, configDir: dir });
      expect(payload.models.map((m) => m.model)).toContain("kimi-k3");
    } finally {
      await client.close();
    }
  }, 30_000);
});
