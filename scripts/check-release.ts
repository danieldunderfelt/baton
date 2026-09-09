import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };

// Exercise the artifact we will ship, with no source tree, Bun, or agent CLI
// on PATH. All global registrations go into a disposable home.
const binary = realpathSync(resolve(process.argv[2] ?? "dist/baton"));
const dir = mkdtempSync(join(tmpdir(), "baton-release-check-"));
function run(...args: string[]): string {
  const result = Bun.spawnSync([binary, ...args], {
    cwd: dir,
    env: {
      HOME: dir,
      PATH: dir,
      BATON_CONFIG_DIR: join(dir, "scope"),
      CODEX_HOME: join(dir, ".codex"),
      CLAUDE_CONFIG_DIR: join(dir, ".claude"),
      KIMI_CODE_HOME: join(dir, ".kimi-code"),
      XDG_CONFIG_HOME: join(dir, ".config"),
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout: 10_000,
  });
  if (result.exitCode !== 0) throw new Error(`${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}
try {
  if (run("--version").trim() !== pkg.version)
    throw new Error("Binary version differs from package.json");
  for (const args of [["--help"], ["install", "--help"], ["update", "--help"], ["mcp", "--help"]]) {
    const help = run(...args);
    if (!help.includes("--user") || !help.includes("baton update"))
      throw new Error("Missing documented commands");
  }
  run("install", "claude-code", "codex", "kimi", "opencode", "--user");
  const config = readFileSync(join(dir, ".codex/config.toml"), "utf8");
  if (!config.includes(JSON.stringify(binary)))
    throw new Error("MCP registration does not point to the tested binary");
  run("status");
  run("ratings");
  console.log(`Release smoke checks passed: ${binary} (${pkg.version})`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
