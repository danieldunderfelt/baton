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
