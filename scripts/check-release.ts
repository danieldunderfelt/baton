import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  run("install", "claude-code", "codex", "kimi", "opencode", "cursor-agent", "--user");
  const config = readFileSync(join(dir, ".codex/config.toml"), "utf8");
  if (!config.includes(JSON.stringify(binary)))
    throw new Error("MCP registration does not point to the tested binary");

  const skillPaths = [".claude/skills/baton/SKILL.md", ".agents/skills/baton/SKILL.md"].map(
    (path) => join(dir, path),
  );
  const skills = skillPaths.map((path) => {
    if (!existsSync(path)) throw new Error(`Missing compiled skill: ${path}`);
    const skill = readFileSync(path, "utf8");
    const frontmatter = /^---\n([\s\S]+?)\n---\n/.exec(skill)?.[1];
    const metadata = frontmatter ? Bun.YAML.parse(frontmatter) : null;
    if (
      !metadata ||
      typeof metadata !== "object" ||
      !("name" in metadata) ||
      metadata.name !== "baton" ||
      !("description" in metadata) ||
      typeof metadata.description !== "string" ||
      !metadata.description.trim()
    )
      throw new Error(`Skill lacks the expected YAML name/description: ${path}`);
    return skill;
  });
  if (new Set(skills).size !== 1) throw new Error("Compiled skills differ between hosts");
  for (const path of [
    ".claude/AGENTS.md",
    ".codex/AGENTS.md",
    ".kimi-code/AGENTS.md",
    ".config/opencode/AGENTS.md",
    ".cursor/AGENTS.md",
  ]) {
    if (existsSync(join(dir, path))) throw new Error(`Fresh install created ${path}`);
  }

  const agentsPath = join(dir, ".codex/AGENTS.md");
  writeFileSync(
    agentsPath,
    "house rules\n<!-- baton:begin -->\nold instructions\n<!-- baton:end -->\n",
  );
  run("install", "codex", "--user");
  if (readFileSync(agentsPath, "utf8") !== "house rules\n")
    throw new Error("Marked AGENTS.md migration did not preserve surrounding text");
  run("status");
  run("ratings");
  console.log(`Release smoke checks passed: ${binary} (${pkg.version})`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
