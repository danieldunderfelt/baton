import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHost } from "./install.ts";

const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "baton-install-test-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("config preservation", () => {
  test("installs the identical skill at every project's discovery path", () => {
    const dir = temp();
    mkdirSync(join(dir, ".git"));

    installHost("claude-code", { dir, withEval: false });
    installHost("codex", { dir, withEval: false });
    installHost("kimi", { dir, withEval: false });
    installHost("opencode", { dir, withEval: false });
    installHost("cursor-agent", { dir, withEval: false });

    const skillPaths = [
      join(dir, ".claude/skills/baton/SKILL.md"),
      join(dir, ".agents/skills/baton/SKILL.md"),
    ];
    const skills = skillPaths.map((path) => readFileSync(path, "utf8"));
    expect(new Set(skills).size).toBe(1);
    expect(skills[0]).toMatch(/^---\nname: baton\ndescription: .+\n---\n/);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    for (const hostDir of [".codex", ".kimi-code", ".opencode", ".cursor"]) {
      expect(existsSync(join(dir, hostDir, "skills/baton/SKILL.md"))).toBe(false);
    }
  });

  test("user overrides relocate MCP configs while shared skills stay in the home directory", () => {
    const home = temp();
    const claude = join(home, "claude");
    const codex = join(home, "codex");
    const kimi = join(home, "kimi");
    const xdg = join(home, "xdg");
    const opencodeConfig = join(home, "opencode.json");
    const env = {
      HOME: home,
      CLAUDE_CONFIG_DIR: claude,
      CODEX_HOME: codex,
      KIMI_CODE_HOME: kimi,
      XDG_CONFIG_HOME: xdg,
      OPENCODE_CONFIG: opencodeConfig,
    };

    const results = [
      installHost("claude-code", { scope: "user", env }),
      installHost("codex", { scope: "user", env }),
      installHost("kimi", { scope: "user", env }),
      installHost("opencode", { scope: "user", env }),
      installHost("cursor-agent", { scope: "user", env }),
    ];

    expect(results.map((result) => result.skillPath)).toEqual([
      join(claude, "skills/baton/SKILL.md"),
      ...Array<string>(4).fill(join(home, ".agents/skills/baton/SKILL.md")),
    ]);
    expect(results.map((result) => result.mcpPath)).toEqual([
      join(claude, ".claude.json"),
      join(codex, "config.toml"),
      join(kimi, "mcp.json"),
      opencodeConfig,
      join(home, ".cursor/mcp.json"),
    ]);
    expect(results.every((result) => result.migratedInstructionsPath === null)).toBe(true);
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
    expect(existsSync(join(home, ".codex"))).toBe(false);
    expect(existsSync(join(home, ".kimi-code"))).toBe(false);
    expect(existsSync(join(home, ".config"))).toBe(false);
    expect(existsSync(join(home, ".cursor/mcp.json"))).toBe(true);
  });

  test("Cursor merges its project MCP config and writes its project skill", () => {
    const dir = temp();
    mkdirSync(join(dir, ".cursor"));
    const path = join(dir, ".cursor/mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: "other" } } }));

    const result = installHost("cursor-agent", { dir });
    const doc = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers: Record<string, { command: string; args?: string[] }>;
    };

    expect(result.mcpPath).toBe(path);
    expect(result.skillPath).toBe(join(dir, ".agents/skills/baton/SKILL.md"));
    expect(result.migratedInstructionsPath).toBeNull();
    expect(doc.mcpServers.other?.command).toBe("other");
    expect(doc.mcpServers.baton?.command).toBe(process.execPath);
    expect(doc.mcpServers.baton?.args?.at(-1)).toBe("mcp");
  });

  test("OpenCode JSONC configs retain comments and receive the effective registration", () => {
    const dir = temp();
    const path = join(dir, "opencode.jsonc");
    writeFileSync(
      path,
      '{\n  // my config\n  "mcp": { "baton": { "enabled": false }, "other": { "type": "remote", "url": "https://example.com" } },\n}\n',
    );
    const result = installHost("opencode", { dir });
    expect(result.mcpPath).toBe(path);
    expect(result.preserved).toEqual(["other"]);
    expect(readFileSync(path, "utf8")).toContain("// my config");
    expect(readFileSync(path, "utf8")).toContain('"enabled": true');
    expect(existsSync(join(dir, "opencode.json"))).toBe(false);
  });

  test("OpenCode uses its explicit user config override", () => {
    const dir = temp();
    const path = join(dir, "work.jsonc");
    const result = installHost("opencode", {
      scope: "user",
      env: { HOME: dir, OPENCODE_CONFIG: path },
    });
    expect(result.mcpPath).toBe(path);
    expect(existsSync(path)).toBe(true);
  });
  test("updating a symlinked config preserves the link", () => {
    const dir = temp();
    const target = join(dir, "shared.json");
    const path = join(dir, ".mcp.json");
    writeFileSync(target, "{}");
    symlinkSync(target, path);
    installHost("claude-code", { dir });
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toContain('"baton"');
  });
  test("reinstalling a commented TOML table keeps other servers and private permissions", () => {
    const dir = temp();
    mkdirSync(join(dir, ".codex"));
    const path = join(dir, ".codex/config.toml");
    writeFileSync(
      path,
      '[mcp_servers.baton] # installed earlier\ncommand = "old"\n[mcp_servers."other.server"] # keep me\ncommand = "other"\n',
      { mode: 0o600 },
    );
    installHost("codex", { dir });
    const raw = readFileSync(path, "utf8");
    expect(() => Bun.TOML.parse(raw)).not.toThrow();
    expect(raw).toContain('[mcp_servers."other.server"] # keep me');
    expect(raw).toContain('command = "other"');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("invalid TOML is left untouched", () => {
    const dir = temp();
    mkdirSync(join(dir, ".codex"));
    const path = join(dir, ".codex/config.toml");
    const raw = 'model = "unterminated\n';
    writeFileSync(path, raw);
    expect(() => installHost("codex", { dir })).toThrow();
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  test("a multiline string that looks like a table cannot silently change", () => {
    const dir = temp();
    mkdirSync(join(dir, ".codex"));
    const path = join(dir, ".codex/config.toml");
    const raw = 'instructions = """\n[mcp_servers.baton]\nkeep this instruction\n"""\n';
    writeFileSync(path, raw);
    expect(() => installHost("codex", { dir })).toThrow();
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  test("custom Claude config lives inside CLAUDE_CONFIG_DIR", () => {
    const dir = temp();
    const config = join(dir, "claude-work");
    const result = installHost("claude-code", {
      scope: "user",
      env: { HOME: dir, CLAUDE_CONFIG_DIR: config },
    });
    expect(result.mcpPath).toBe(join(config, ".claude.json"));
    expect(existsSync(join(dir, ".claude.json"))).toBe(false);
    expect(statSync(result.mcpPath).mode & 0o777).toBe(0o600);
  });

  test("malformed server containers are not replaced", () => {
    const dir = temp();
    const path = join(dir, ".mcp.json");
    const raw = '{"mcpServers": ["keep"]}\n';
    writeFileSync(path, raw);
    expect(() => installHost("claude-code", { dir })).toThrow();
    expect(readFileSync(path, "utf8")).toBe(raw);
  });
});

describe("legacy AGENTS.md migration", () => {
  test("removes a Baton-only file, but keeps a symlink to an empty migrated file", () => {
    const dir = temp();
    const path = join(dir, "AGENTS.md");
    const block = "<!-- baton:begin -->\nold\n<!-- baton:end -->\n";
    writeFileSync(path, block);
    installHost("codex", { dir });
    expect(existsSync(path)).toBe(false);

    const target = join(dir, "shared-rules.md");
    writeFileSync(target, block);
    symlinkSync(target, path);
    installHost("codex", { dir });
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("");
  });

  test("Claude-only installation preserves other apps' legacy instructions", () => {
    const dir = temp();
    const path = join(dir, "AGENTS.md");
    const original = "house\n<!-- baton:begin -->\nold\n<!-- baton:end -->\n";
    writeFileSync(path, original);
    expect(installHost("claude-code", { dir }).migratedInstructionsPath).toBeNull();
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(existsSync(join(dir, ".agents"))).toBe(false);
  });

  test("shared skills install at the Git root even when called from a subdirectory", () => {
    const root = temp();
    const dir = join(root, "packages", "app");
    mkdirSync(join(root, ".git"));
    mkdirSync(dir, { recursive: true });
    for (const host of ["codex", "kimi", "opencode", "cursor-agent"] as const) {
      expect(installHost(host, { dir }).skillPath).toBe(
        join(root, ".agents/skills/baton/SKILL.md"),
      );
    }
    expect(existsSync(join(dir, ".agents"))).toBe(false);
  });

  test("migrates user instructions from overridden config roots to the shared skill", () => {
    const home = temp();
    const env = {
      HOME: home,
      CODEX_HOME: join(home, "codex"),
      KIMI_CODE_HOME: join(home, "kimi"),
      XDG_CONFIG_HOME: join(home, "xdg"),
    };
    const hosts = [
      ["codex", join(env.CODEX_HOME, "AGENTS.md")],
      ["kimi", join(env.KIMI_CODE_HOME, "AGENTS.md")],
      ["opencode", join(env.XDG_CONFIG_HOME, "opencode/AGENTS.md")],
    ] as const;
    for (const [host, path] of hosts) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "house\n<!-- baton:begin -->\nold\n<!-- baton:end -->\n");
      const result = installHost(host, { scope: "user", env });
      expect(result.migratedInstructionsPath).toBe(path);
      expect(readFileSync(path, "utf8")).toBe("house\n");
      expect(result.skillPath).toBe(join(home, ".agents/skills/baton/SKILL.md"));
    }
  });

  test("removes multiple complete CRLF blocks while preserving all other bytes", () => {
    const target = temp();
    const agents =
      "house\r\n<!-- baton:begin -->\r\nold one\r\n<!-- baton:end -->\r\nbetween\r\n<!-- baton:begin -->\r\nold two\r\n<!-- baton:end -->\r\nafter\r\n";
    writeFileSync(join(target, "AGENTS.md"), agents);

    const result = installHost("codex", { dir: target });

    expect(result.migratedInstructionsPath).toBe(join(target, "AGENTS.md"));
    expect(readFileSync(join(target, "AGENTS.md"), "utf8")).toBe("house\r\nbetween\r\nafter\r\n");
    expect(readFileSync(join(target, ".agents/skills/baton/SKILL.md"), "utf8")).toContain(
      "name: baton",
    );
  });

  test("updates a symlinked AGENTS.md target without replacing the link", () => {
    const target = temp();
    const actual = join(target, "rules.md");
    const agents = join(target, "AGENTS.md");
    writeFileSync(actual, "before\n<!-- baton:begin -->\nold\n<!-- baton:end -->\nafter\n");
    symlinkSync(actual, agents);

    const result = installHost("kimi", { dir: target });

    expect(result.migratedInstructionsPath).toBe(agents);
    expect(lstatSync(agents).isSymbolicLink()).toBe(true);
    expect(readFileSync(actual, "utf8")).toBe("before\nafter\n");
  });

  test("rejects nested and unmatched markers before writing any file", () => {
    const cases = [
      "# Rules\n<!-- baton:begin -->\nfirst\n<!-- baton:begin -->\nsecond\n<!-- baton:end -->\n",
      "# Rules\n<!-- baton:end -->\n",
    ];
    for (const agents of cases) {
      const target = temp();
      writeFileSync(join(target, "AGENTS.md"), agents);

      expect(() => installHost("opencode", { dir: target })).toThrow();
      expect(readFileSync(join(target, "AGENTS.md"), "utf8")).toBe(agents);
      expect(existsSync(join(target, "opencode.json"))).toBe(false);
      expect(existsSync(join(target, ".agents/skills/baton/SKILL.md"))).toBe(false);
    }
  });
});
