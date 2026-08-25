import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { AdapterSpec } from "../adapters/types.ts";
import { canonicalSpecJson, shortDigest, specDigest } from "../discovery/discovery.ts";
import type { DiscoveredStatus } from "../discovery/types.ts";
import { newId, nowIso, openStore } from "../store/store.ts";
import { adaptersApprove } from "./cli.ts";

/**
 * The CLI is tested as a subprocess: exit codes and the two streams are its
 * contract. Every run gets a throwaway BATON_CONFIG_DIR, so nothing here can
 * touch the developer's real scope, and no test invokes a callee CLI.
 */

const ENTRY = resolve(import.meta.dir, "..", "index.ts");
const HTTP_MODULE = resolve(import.meta.dir, "..", "mcp", "http.ts");

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `baton-cli-${prefix}-`));
}

async function baton(
  scope: string,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await spawnBaton({ BATON_CONFIG_DIR: scope }, args);
}

/** Same, with a throwaway bin directory ahead of PATH: the callees are fakes. */
async function batonOnPath(
  scope: string,
  bin: string,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await spawnBaton(
    { BATON_CONFIG_DIR: scope, PATH: `${bin}:${process.env.PATH ?? ""}` },
    args,
  );
}

async function spawnBaton(
  env: Record<string, string>,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "run", ENTRY, ...args], {
    env: { ...process.env, BATON_HOPS: undefined, ...env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("status", () => {
  test("reports the BATON_CONFIG_DIR scope, db path and identity env", async () => {
    const scope = tmp("status");
    const res = await baton(scope, "status");

    expect(res.code).toBe(0);
    expect(res.stdout).toContain(scope);
    expect(res.stdout).toContain("BATON_CONFIG_DIR");
    expect(res.stdout).toContain(join(scope, "state", "baton.db"));
    expect(res.stdout).toContain("CLAUDE_CONFIG_DIR");
    expect(res.stdout).toContain("KIMI_CODE_HOME");
    expect(res.stdout).toContain("adapters:");
  });

  test("marks absent identity vars as (unset) and hop depth as 0", async () => {
    const res = await baton(tmp("unset"), "status");
    expect(res.stdout).toMatch(/CODEX_HOME\s+\(unset\)/);
    // opencode has no identity var to report; claiming one would invite a
    // scope separation that does not exist.
    expect(res.stdout).not.toContain("OPENCODE_CONFIG_DIR");
    expect(res.stdout).toContain("0 (BATON_HOPS=unset)");
  });
});

describe("set + models", () => {
  test("a written ceiling shows up in models", async () => {
    const scope = tmp("set");
    const before = await baton(scope, "models");
    expect(before.code).toBe(0);
    expect(before.stdout).toContain("gpt-5.6-sol");
    expect(before.stdout).toMatch(/gpt-5\.6-sol\s+codex\/gpt-5\.6-sol\s+\w+\s+full/);

    const set = await baton(scope, "set", "max_autonomy:codex", "readonly");
    expect(set.code).toBe(0);
    expect(set.stdout).toContain("max_autonomy:codex = readonly");

    const after = await baton(scope, "models");
    expect(after.stdout).toMatch(/gpt-5\.6-sol\s+codex\/gpt-5\.6-sol\s+\w+\s+readonly/);
    // Scoping: another app's ceiling is untouched.
    expect(after.stdout).toMatch(/kimi-k3\s+kimi\/kimi-code\/k3\s+\w+\s+full/);
  });

  test("max_hops round-trips", async () => {
    const scope = tmp("hops");
    expect((await baton(scope, "set", "max_hops", "4")).code).toBe(0);
    expect((await baton(scope, "set", "max_hops", "-1")).code).toBe(2);
  });

  test("rejects an unknown key with the valid ones", async () => {
    const res = await baton(tmp("badkey"), "set", "max_tokens", "10");
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("unknown setting 'max_tokens'");
    expect(res.stderr).toContain("max_hops");
    expect(res.stderr).toContain("max_autonomy:codex");
  });

  test("rejects a ceiling for an unknown app", async () => {
    const res = await baton(tmp("badapp"), "set", "max_autonomy:nope", "full");
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("unknown app 'nope'");
  });
});

describe("instance", () => {
  test("add, list, remove round-trip", async () => {
    const scope = tmp("inst");
    expect((await baton(scope, "instance", "list")).stdout).toContain("No instances");

    const add = await baton(
      scope,
      "instance",
      "add",
      "kimi",
      "work",
      "--env",
      "KIMI_CODE_HOME=/tmp/kimi-work",
    );
    expect(add.code).toBe(0);

    const list = await baton(scope, "instance", "list");
    expect(list.stdout).toContain("kimi");
    expect(list.stdout).toContain("work");
    expect(list.stdout).toContain("KIMI_CODE_HOME=/tmp/kimi-work");

    expect((await baton(scope, "instance", "remove", "kimi", "work")).code).toBe(0);
    expect((await baton(scope, "instance", "list")).stdout).toContain("No instances");

    const gone = await baton(scope, "instance", "remove", "kimi", "work");
    expect(gone.code).toBe(1);
    expect(gone.stderr).toContain("no instance kimi:work");
  });

  test("rejects an app with no identity env var, and an overlay that ignores it", async () => {
    const scope = tmp("inst-identity");
    // opencode's credentials follow neither a config-dir var nor HOME, so a
    // second 'instance' of it is the same account under another name.
    const noIdentity = await baton(
      scope,
      "instance",
      "add",
      "opencode",
      "work",
      "--env",
      "OPENCODE_CONFIG_DIR=/tmp/oc",
    );
    expect(noIdentity.code).toBe(2);
    expect(noIdentity.stderr).toContain("no identity env var");

    // An overlay that does not relocate the identity is two names, one account.
    const wrongVar = await baton(
      scope,
      "instance",
      "add",
      "kimi",
      "work",
      "--env",
      "KIMI_THEME=dark",
    );
    expect(wrongVar.code).toBe(2);
    expect(wrongVar.stderr).toContain("must set KIMI_CODE_HOME");
    expect((await baton(scope, "instance", "list")).stdout).toContain("No instances");
  });

  test("removing an instance removes it from the pool too, and says so", async () => {
    const scope = tmp("inst-pool");
    await baton(scope, "instance", "add", "kimi", "work", "--env", "KIMI_CODE_HOME=/tmp/kimi-work");
    await baton(scope, "instance", "add", "kimi", "spare", "--env", "KIMI_CODE_HOME=/tmp/kimi-2");
    expect((await baton(scope, "pool", "set", "kimi", "work", "spare")).code).toBe(0);

    const removed = await baton(scope, "instance", "remove", "kimi", "work");
    expect(removed.code).toBe(0);
    expect(removed.stderr).toContain("also removed 'work' from the kimi pool");
    // A dangling member would fail selection closed; the pool is fixed instead.
    expect((await baton(scope, "pool", "list")).stdout).not.toContain("work");
    expect((await baton(scope, "pool", "list")).stdout).toContain("spare");

    // Removing the last member clears the pool rather than emptying it.
    const last = await baton(scope, "instance", "remove", "kimi", "spare");
    expect(last.stderr).toContain("no pool");
    expect((await baton(scope, "pool", "list")).stdout).toContain("No pools defined");
  });

  test("rejects an unknown app and a malformed --env", async () => {
    const scope = tmp("inst-bad");
    const badApp = await baton(scope, "instance", "add", "vim", "x", "--env", "A=B");
    expect(badApp.code).toBe(2);
    expect(badApp.stderr).toContain("unknown app 'vim'");

    const badEnv = await baton(scope, "instance", "add", "kimi", "x", "--env", "nonsense");
    expect(badEnv.code).toBe(2);
    expect(badEnv.stderr).toContain("KEY=VALUE");
  });
});

describe("install claude-code", () => {
  test("registers the server, preserves other servers, writes the skill", async () => {
    const scope = tmp("install-scope");
    const target = tmp("install-target");
    writeFileSync(
      join(target, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "other-server", args: ["--stdio"] } } }),
    );

    const res = await baton(scope, "install", "claude-code", "--dir", target);
    expect(res.code).toBe(0);

    const doc = (await Bun.file(join(target, ".mcp.json")).json()) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(Object.keys(doc.mcpServers).sort()).toEqual(["baton", "other"]);
    expect(doc.mcpServers.other?.command).toBe("other-server");
    const baton_ = doc.mcpServers.baton!;
    expect(baton_.args.at(-1)).toBe("mcp");
    expect(baton_.command === "bun" ? baton_.args[1] : baton_.command).toStartWith("/");

    const skill = await Bun.file(join(target, ".claude", "skills", "baton", "SKILL.md")).text();
    expect(skill).toStartWith("---\n");
    expect(skill).toContain("name: baton");
    expect(skill).toContain("run_model");
    // The parallel-delegation advice has to be actionable, the key's payload
    // binding has to be stated, and ratings have to point at the live source.
    expect(skill).toContain('options.autonomy: "readonly"');
    expect(skill).toContain("byte-identical retry");
    expect(skill).toContain("live rating");
  });

  test("creates .mcp.json when absent and leaves no tmp files", async () => {
    const target = tmp("install-fresh");
    const res = await baton(tmp("install-fresh-scope"), "install", "claude-code", "--dir", target);
    expect(res.code).toBe(0);
    expect(existsSync(join(target, ".mcp.json"))).toBe(true);
    const entries = [...new Bun.Glob("*").scanSync({ cwd: target, onlyFiles: true, dot: true })];
    expect(entries).toEqual([".mcp.json"]);
  });

  test("refuses to clobber an unparseable .mcp.json", async () => {
    const target = tmp("install-broken");
    writeFileSync(join(target, ".mcp.json"), "{ not json");
    const res = await baton(tmp("install-broken-scope"), "install", "claude-code", "--dir", target);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("not valid JSON");
    expect(await Bun.file(join(target, ".mcp.json")).text()).toBe("{ not json");
  });

  test("rejects an unsupported host", async () => {
    const res = await baton(tmp("install-host"), "install", "emacs");
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("unsupported host 'emacs'");
    expect(res.stderr).toContain("codex");
  });

  test("--with-eval appends grading and the onboarding interview", async () => {
    const plain = tmp("install-plain");
    await baton(tmp("install-plain-scope"), "install", "claude-code", "--dir", plain);
    const without = readFileSync(join(plain, ".claude", "skills", "baton", "SKILL.md"), "utf8");
    // The core tells every host to grade what it used; the grading rubric and
    // the seeding interview are what --with-eval adds on top.
    expect(without).not.toContain("seed_ratings");

    const target = tmp("install-eval");
    const res = await baton(
      tmp("install-eval-scope"),
      "install",
      "claude-code",
      "--dir",
      target,
      "--with-eval",
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("grading + onboarding");
    const skill = readFileSync(join(target, ".claude", "skills", "baton", "SKILL.md"), "utf8");
    expect(skill).toContain("report_result(run_id, grade, notes?)");
    // Consumer grades, the interview, and the upsert rule for duel verdicts.
    expect(skill).toContain("after you have used its result");
    expect(skill).toContain("seed_ratings");
    expect(skill).toContain("Echo the normalized entries back");
    expect(skill).toContain("`report_duel` is an upsert too");
  });
});

describe("install codex", () => {
  test("merges [mcp_servers.baton] into an existing config.toml, keeping everything else", async () => {
    const target = tmp("codex-target");
    const configPath = join(target, ".codex", "config.toml");
    writeFileSync(
      join(target, "AGENTS.md"),
      "# House rules\n\nAlways run the tests before you commit.\n",
    );
    mkdirSync(join(target, ".codex"));
    writeFileSync(
      configPath,
      `model = "gpt-5.6-sol"

[mcp_servers.other]
command = "other-server"
args = ["--stdio"]

[tui]
theme = "dark"
`,
    );

    const res = await baton(tmp("codex-scope"), "install", "codex", "--dir", target);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("kept: other");
    expect(res.stdout).toContain("trusted");

    const toml = readFileSync(configPath, "utf8");
    expect(toml).toContain('model = "gpt-5.6-sol"');
    expect(toml).toContain("[mcp_servers.other]");
    expect(toml).toContain('theme = "dark"');
    expect(toml).toContain("[mcp_servers.baton]");
    expect(toml).toMatch(/args = \["mcp"\]/);

    // The instruction block is appended, the user's own AGENTS.md content stays.
    const agents = readFileSync(join(target, "AGENTS.md"), "utf8");
    expect(agents).toContain("Always run the tests before you commit.");
    expect(agents).toContain("<!-- baton:begin -->");
    expect(agents).toContain("run_model");
  });

  test("re-running replaces the block instead of stacking copies", async () => {
    const target = tmp("codex-twice");
    const scope = tmp("codex-twice-scope");
    await baton(scope, "install", "codex", "--dir", target);
    const second = await baton(scope, "install", "codex", "--dir", target, "--with-eval");
    expect(second.code).toBe(0);

    const toml = readFileSync(join(target, ".codex", "config.toml"), "utf8");
    expect(occurrences(toml, "[mcp_servers.baton]")).toBe(1);
    const agents = readFileSync(join(target, "AGENTS.md"), "utf8");
    expect(occurrences(agents, "<!-- baton:begin -->")).toBe(1);
    expect(occurrences(agents, "<!-- baton:end -->")).toBe(1);
    expect(agents).toContain("report_result");
  });

  // Appending our table beside any of these produces a config codex refuses to
  // load at all, and there is no TOML parser here to rewrite them safely.
  const unmergeable: [string, string][] = [
    ["a dotted-key baton entry", 'mcp_servers.baton.command = "old-baton"\n'],
    ["an inline-table baton entry", 'mcp_servers.baton = { command = "old-baton" }\n'],
    ["a dotted key under [mcp_servers]", '[mcp_servers]\nbaton.command = "old-baton"\n'],
    ["mcp_servers as one inline table", 'mcp_servers = { baton = { command = "x" } }\n'],
    ["another server declared with dotted keys", 'mcp_servers.other.command = "other"\n'],
  ];

  for (const [what, body] of unmergeable) {
    test(`refuses ${what} instead of writing duplicate TOML`, async () => {
      const target = tmp("codex-dotted");
      const configPath = join(target, ".codex", "config.toml");
      mkdirSync(join(target, ".codex"));
      const before = `model = "gpt-5.6-sol"\n${body}`;
      writeFileSync(configPath, before);

      const res = await baton(tmp("codex-dotted-scope"), "install", "codex", "--dir", target);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain("twice");
      expect(res.stderr).toContain("[mcp_servers.<name>]");
      // Nothing written: not the TOML, not the instruction block.
      expect(readFileSync(configPath, "utf8")).toBe(before);
      expect(existsSync(join(target, "AGENTS.md"))).toBe(false);
    });
  }

  test("keeps a sibling server declared inline under [mcp_servers]", async () => {
    const target = tmp("codex-sibling");
    const configPath = join(target, ".codex", "config.toml");
    mkdirSync(join(target, ".codex"));
    writeFileSync(configPath, '[mcp_servers]\nother = { command = "other-server" }\n');

    const res = await baton(tmp("codex-sibling-scope"), "install", "codex", "--dir", target);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("kept: other");

    const toml = readFileSync(configPath, "utf8");
    expect(toml).toContain('other = { command = "other-server" }');
    expect(occurrences(toml, "[mcp_servers.baton]")).toBe(1);
  });
});

describe("install into a damaged AGENTS.md", () => {
  test("refuses a begin marker with no end marker instead of guessing", async () => {
    const target = tmp("agents-broken");
    const agents = "# Rules\n\n<!-- baton:begin -->\nhalf a block\n";
    writeFileSync(join(target, "AGENTS.md"), agents);

    const res = await baton(tmp("agents-broken-scope"), "install", "kimi", "--dir", target);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("refusing to guess");
    expect(readFileSync(join(target, "AGENTS.md"), "utf8")).toBe(agents);
  });
});

describe("install opencode", () => {
  test("merges mcp.baton as a local server and preserves other entries", async () => {
    const target = tmp("opencode-target");
    writeFileSync(
      join(target, "opencode.json"),
      JSON.stringify({ model: "opencode/x", mcp: { other: { type: "remote", url: "http://x" } } }),
    );

    const res = await baton(tmp("opencode-scope"), "install", "opencode", "--dir", target);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("kept: other");

    const doc = JSON.parse(readFileSync(join(target, "opencode.json"), "utf8")) as {
      model: string;
      mcp: Record<string, { type: string; url?: string; command?: string[]; enabled?: boolean }>;
    };
    expect(doc.model).toBe("opencode/x");
    expect(doc.mcp.other?.url).toBe("http://x");
    expect(doc.mcp.baton?.type).toBe("local");
    expect(doc.mcp.baton?.command?.at(-1)).toBe("mcp");
    expect(doc.mcp.baton?.enabled).toBe(true);
    expect(readFileSync(join(target, "AGENTS.md"), "utf8")).toContain("<!-- baton:begin -->");
  });
});

describe("install kimi", () => {
  // Kimi resolves the Claude-compatible file at the *repository* root (nearest
  // .git above the session's cwd), so where the registration belongs depends on
  // whether the target directory is that root.
  test("registers in the project .mcp.json at a repository root", async () => {
    const target = tmp("kimi-target");
    mkdirSync(join(target, ".git"));
    const res = await baton(tmp("kimi-scope"), "install", "kimi", "--dir", target);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(".mcp.json");
    expect(res.stdout).toContain("Claude-compatible");

    const doc = JSON.parse(readFileSync(join(target, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(doc.mcpServers.baton?.args.at(-1)).toBe("mcp");
    expect(readFileSync(join(target, "AGENTS.md"), "utf8")).toContain(
      "Delegating through Baton",
    );
  });

  test("registers in .kimi-code/mcp.json where a root .mcp.json would never be read", async () => {
    const target = tmp("kimi-subdir");
    const res = await baton(tmp("kimi-subdir-scope"), "install", "kimi", "--dir", target);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(join(".kimi-code", "mcp.json"));
    expect(res.stdout).toContain("not a repository root");
    expect(existsSync(join(target, ".mcp.json"))).toBe(false);

    const doc = JSON.parse(readFileSync(join(target, ".kimi-code", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(doc.mcpServers.baton?.args.at(-1)).toBe("mcp");
  });

  test("merges into an existing .kimi-code/mcp.json instead of replacing it", async () => {
    const target = tmp("kimi-merge");
    mkdirSync(join(target, ".kimi-code"));
    writeFileSync(
      join(target, ".kimi-code", "mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "other-server" } } }),
    );

    const res = await baton(tmp("kimi-merge-scope"), "install", "kimi", "--dir", target);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("kept: other");

    const doc = JSON.parse(readFileSync(join(target, ".kimi-code", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(Object.keys(doc.mcpServers).sort()).toEqual(["baton", "other"]);
  });
});

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("pool", () => {
  test("set, list and clear round-trip", async () => {
    const scope = tmp("pool");
    expect((await baton(scope, "pool", "list")).stdout).toContain("No pools defined");

    await baton(scope, "instance", "add", "kimi", "work", "--env", "KIMI_CODE_HOME=/tmp/kimi-work");
    const set = await baton(scope, "pool", "set", "kimi", "default", "work");
    expect(set.code).toBe(0);
    expect(set.stdout).toContain("Pool kimi: default, work");

    const list = await baton(scope, "pool", "list");
    expect(list.stdout).toMatch(/kimi\s+default\s+burn\s+1/);
    expect(list.stdout).toMatch(/kimi\s+work\s+burn\s+1/);

    expect((await baton(scope, "pool", "clear", "kimi")).code).toBe(0);
    expect((await baton(scope, "pool", "list")).stdout).toContain("No pools defined");
    const gone = await baton(scope, "pool", "clear", "kimi");
    expect(gone.code).toBe(1);
    expect(gone.stderr).toContain("no pool for app 'kimi'");
  });

  test("rejects an unknown app and an instance this scope never defined", async () => {
    const scope = tmp("pool-bad");
    const badApp = await baton(scope, "pool", "set", "vim", "default");
    expect(badApp.code).toBe(2);
    expect(badApp.stderr).toContain("unknown app 'vim'");

    const badMember = await baton(scope, "pool", "set", "kimi", "default", "ghost");
    expect(badMember.code).toBe(1);
    expect(badMember.stderr).toContain("Unknown instance 'ghost'");
  });
});

describe("set (phase-2 keys)", () => {
  test("preciousness lands on the pool member it names", async () => {
    const scope = tmp("precious");
    await baton(scope, "instance", "add", "kimi", "work", "--env", "KIMI_CODE_HOME=/tmp/kimi-work");
    await baton(scope, "pool", "set", "kimi", "default", "work");

    const ok = await baton(scope, "set", "preciousness:kimi:work", "conserve");
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("preciousness:kimi:work = conserve");

    const list = await baton(scope, "pool", "list");
    expect(list.stdout).toMatch(/kimi\s+work\s+conserve/);
    expect(list.stdout).toMatch(/kimi\s+default\s+burn/);
  });

  test("rejects an unknown app, an unknown level, and a missing instance", async () => {
    const scope = tmp("precious-bad");
    const app = await baton(scope, "set", "preciousness:vim:default", "burn");
    expect(app.code).toBe(2);
    expect(app.stderr).toContain("unknown app 'vim'");

    const level = await baton(scope, "set", "preciousness:kimi:default", "hoard");
    expect(level.code).toBe(2);
    expect(level.stderr).toContain("invalid preciousness 'hoard'");
    expect(level.stderr).toContain("emergency");

    const shape = await baton(scope, "set", "preciousness:kimi", "burn");
    expect(shape.code).toBe(2);
    expect(shape.stderr).toContain("<app>:<instance>");
  });

  test("half_life_days and profile_weight take numbers and reject the rest", async () => {
    const scope = tmp("evalkeys");
    expect((await baton(scope, "set", "half_life_days", "30")).stdout).toContain(
      "half_life_days = 30",
    );
    expect((await baton(scope, "set", "half_life_days", "0")).code).toBe(2);
    expect((await baton(scope, "set", "half_life_days", "1.5")).code).toBe(2);

    expect((await baton(scope, "set", "profile_weight", "0.5")).stdout).toContain(
      "profile_weight = 0.5",
    );
    expect((await baton(scope, "set", "profile_weight", "-1")).code).toBe(2);
  });

  test("a setting that changes what ratings.yaml says reaches the projection", async () => {
    const scope = tmp("evalpublish");
    await baton(scope, "ratings", "publish");
    const before = readFileSync(join(scope, "ratings.yaml"), "utf8");
    expect(before).toContain("source_revision: 0");
    expect(before).toContain("profile_weight: 1");

    // These settings mutate no eval table, so without a revision bump in the
    // same commit the publisher would discard the refreshed render as stale.
    expect((await baton(scope, "set", "profile_weight", "0.25")).code).toBe(0);
    const after = readFileSync(join(scope, "ratings.yaml"), "utf8");
    expect(after).toContain("source_revision: 1");
    expect(after).toContain("profile_weight: 0.25");
  });

  test("active_profile only accepts a profile this scope actually has", async () => {
    const scope = tmp("activeprofile");
    const res = await baton(scope, "set", "active_profile", "team");
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("no profiles yet");
  });

  test("the phase-2 keys are advertised among the valid ones", async () => {
    const res = await baton(tmp("keys2"), "set", "nonsense", "1");
    expect(res.stderr).toContain("half_life_days");
    expect(res.stderr).toContain("profile_weight");
    expect(res.stderr).toContain("active_profile");
    expect(res.stderr).toContain("preciousness:<app>:<instance>");
  });
});

/**
 * Seeds a run and the attempt that answered it, so grading has something real
 * to attach to without spawning a callee. Mirrors what the supervisor writes.
 */
function seedRun(scope: string, opts: { succeeded: boolean; sessionRef?: string }): string {
  mkdirSync(join(scope, "state"), { recursive: true, mode: 0o700 });
  const db = openStore(join(scope, "state", "baton.db"));
  const runId = newId("run");
  const at = nowIso();
  db.query(
    `INSERT INTO runs (id, model, app, slug, instance, prompt, cwd, status, created_at, updated_at)
     VALUES (?, 'kimi-k3', 'kimi', 'kimi-code/k3', 'default', 'do a thing', '/tmp', ?, ?, ?)`,
  ).run(runId, opts.succeeded ? "succeeded" : "failed", at, at);
  db.query(
    `INSERT INTO attempts (id, run_id, seq, target, status, session_ref, started_at, finished_at)
     VALUES (?, ?, 1, 'kimi:default/kimi-code/k3@a1', ?, ?, ?, ?)`,
  ).run(
    newId("att"),
    runId,
    opts.succeeded ? "succeeded" : "failed",
    opts.sessionRef ?? null,
    at,
    at,
  );
  db.close();
  return runId;
}

describe("grade and ratings", () => {
  test("a graded run shows up in ratings and in the published projection", async () => {
    const scope = tmp("grade");
    const runId = seedRun(scope, { succeeded: true });

    const graded = await baton(scope, "grade", runId, "4", "solid", "but", "verbose");
    expect(graded.code).toBe(0);
    expect(graded.stdout).toContain("kimi:default/kimi-code/k3@a1");

    const ratings = await baton(scope, "ratings");
    expect(ratings.code).toBe(0);
    // n_eff is 1 observation, give or take the decay arithmetic's last bit.
    expect(ratings.stdout).toMatch(/kimi-k3\s+-\s+4(\.00)? \(1(\.00)?\)/);
    expect(ratings.stdout).toContain("revision");

    const yaml = readFileSync(join(scope, "ratings.yaml"), "utf8");
    expect(yaml).toContain("source_revision: 1");
    expect(yaml).toContain("kimi-k3");
    expect(yaml).toContain("mean: 4");

    // Upsert: re-grading replaces rather than adding a second observation.
    expect((await baton(scope, "grade", runId, "2")).code).toBe(0);
    const after = await baton(scope, "ratings");
    expect(after.stdout).toMatch(/kimi-k3\s+-\s+2(\.00)? \(1(\.00)?\)/);
  });

  test("refuses a run that never produced an answer, and an unknown one", async () => {
    const scope = tmp("grade-bad");
    const runId = seedRun(scope, { succeeded: false });

    const failed = await baton(scope, "grade", runId, "3");
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("produced no answer");

    const unknown = await baton(scope, "grade", "run_nope", "3");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("unknown run 'run_nope'");

    const outOfRange = await baton(scope, "grade", runId, "9");
    expect(outOfRange.code).toBe(2);
    expect(outOfRange.stderr).toContain("between 1 and 5");
  });

  test("ratings publish refreshes the projection after a weight change", async () => {
    const scope = tmp("publish");
    const runId = seedRun(scope, { succeeded: true });
    await baton(scope, "grade", runId, "5");

    const already = await baton(scope, "ratings", "publish");
    expect(already.code).toBe(0);
    expect(already.stdout).toContain("already at revision");

    await baton(scope, "set", "profile_weight", "2");
    const yaml = readFileSync(join(scope, "ratings.yaml"), "utf8");
    expect(yaml).toContain("profile_weight: 2");
  });
});

const PROFILE_FILE = `name: team
exported_at: 2026-08-01T00:00:00.000Z
entries:
  - model: kimi-k3
    category: ""
    mean: 4.5
    weight: 5
  - model: gpt-5.6-sol
    category: review
    mean: 4
    weight: 5
`;

describe("profile import", () => {
  test("shows the diff, writes nothing without --yes, then commits with it", async () => {
    const scope = tmp("import");
    const file = join(tmp("import-file"), "team.yaml");
    writeFileSync(file, PROFILE_FILE);

    const dry = await baton(scope, "profile", "import", file);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("Profile 'team' → local profile 'team'");
    expect(dry.stdout).toContain("+ kimi-k3 mean 4.50 weight 5");
    expect(dry.stdout).toContain("+ gpt-5.6-sol [review] mean 4 weight 5");
    expect(dry.stdout).toContain("2 added, 0 changed, 0 unchanged");
    expect(dry.stdout).toContain("Nothing was written");
    expect((await baton(scope, "ratings")).stdout).toContain("No ratings yet");

    const committed = await baton(scope, "profile", "import", file, "--yes", "--activate");
    expect(committed.code).toBe(0);
    expect(committed.stdout).toContain("2 added");
    expect(committed.stdout).toContain("Active profile is now 'team'");

    const ratings = await baton(scope, "ratings");
    expect(ratings.stdout).toContain("team");
    expect(ratings.stdout).toMatch(/kimi-k3\s+-\s+-\s+4\.50 \(imported:team\)/);

    // Re-importing the same file is a no-op the diff states as such.
    const again = await baton(scope, "profile", "import", file, "--yes");
    expect(again.stdout).toContain("0 added, 0 changed, 2 unchanged");
  });

  test("the dry run reports an as_of-only refresh, and says which date it was", async () => {
    const scope = tmp("import-as-of");
    const dir = tmp("import-as-of-file");
    const older = join(dir, "old.yaml");
    const newer = join(dir, "new.yaml");
    const entries = (asOf: string) =>
      `name: team\nexported_at: ${asOf}\nentries:\n  - model: kimi-k3\n    category: ""\n    mean: 4.5\n    weight: 5\n    as_of: ${asOf}\n`;
    writeFileSync(older, entries("2025-01-01T00:00:00.000Z"));
    writeFileSync(newer, entries("2026-08-01T00:00:00.000Z"));

    expect((await baton(scope, "profile", "import", older, "--yes")).stdout).toContain("1 added");

    // Same mean and weight, a year and a half newer: the prior's precision is
    // restored, so this is a change — and the preview has to show why.
    const dry = await baton(scope, "profile", "import", newer);
    expect(dry.stdout).toContain("0 added, 1 changed, 0 unchanged");
    expect(dry.stdout).toContain("as_of 2025-01-01");
    // The preview must match what committing then reports.
    expect((await baton(scope, "profile", "import", newer, "--yes")).stdout).toContain(
      "0 added, 1 changed, 0 unchanged",
    );
  });

  test("--name renames locally while provenance keeps the file's name", async () => {
    const scope = tmp("import-name");
    const file = join(tmp("import-name-file"), "team.yaml");
    writeFileSync(file, PROFILE_FILE);

    const res = await baton(scope, "profile", "import", file, "--name", "mine", "--yes");
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Profile 'team' → local profile 'mine'");
    expect(res.stdout).toContain("Not activated");

    const activated = await baton(scope, "set", "active_profile", "mine");
    expect(activated.code).toBe(0);
    expect((await baton(scope, "ratings")).stdout).toContain("imported:team");

    const unknown = await baton(scope, "set", "active_profile", "team");
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("Known profiles: mine");
  });

  test("a malformed profile file is rejected before anything is written", async () => {
    const scope = tmp("import-bad");
    const file = join(tmp("import-bad-file"), "bad.yaml");
    writeFileSync(file, "name: team\nentries:\n  - model: kimi:default/k3\n    mean: 4\n");
    const res = await baton(scope, "profile", "import", file, "--yes");
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("canonical model id");
    expect((await baton(scope, "ratings")).stdout).toContain("No ratings yet");
  });
});

describe("run and runs", () => {
  test("an unknown model fails before anything is spawned", async () => {
    const scope = tmp("run-unknown");
    const res = await baton(scope, "run", "gpt-9", "do the thing");

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("Unknown model 'gpt-9'");
    expect(res.stderr).toContain("kimi-k3");
    expect((await baton(scope, "runs")).stdout).toContain("No runs in this scope yet.");
  });

  test("rejects a bad autonomy value and an unknown run id", async () => {
    const scope = tmp("run-flags");
    const bad = await baton(scope, "run", "--autonomy", "godmode", "kimi-k3", "hi");
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("invalid autonomy 'godmode'");

    const missing = await baton(scope, "runs", "run_nope");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("unknown run 'run_nope'");
  });
});

describe("run cancellation", () => {
  test("SIGINT kills the callee's process group and leaves the run cancelled", async () => {
    const scope = tmp("cancel");
    const { bin, pidfile } = fakeKimi();
    // Spawned without `bun run`, so the signal lands on the process that owns
    // the run rather than on a wrapper.
    const proc = Bun.spawn([process.execPath, ENTRY, "run", "kimi-k3", "sleep for a while"], {
      env: {
        ...process.env,
        BATON_CONFIG_DIR: scope,
        BATON_HOPS: undefined,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });

    // Both the callee and its grandchild: only a group kill reaches the second.
    const pids = await poll("the fake callee to spawn", 15_000, () => {
      const found = readPids(pidfile);
      return found.length >= 2 ? found : undefined;
    });

    proc.kill("SIGINT");
    expect(await proc.exited).toBe(130);
    await poll("the callee's process group to die", 15_000, () =>
      pids.every((pid) => !alive(pid)) ? true : undefined,
    );

    const listed = await baton(scope, "runs");
    expect(listed.stdout).toContain("cancelled");
  }, 45_000);
});

/**
 * A throwaway `kimi` for PATH: it records its own pid and a grandchild's, then
 * sleeps. The grandchild ignores SIGTERM, so the group only dies if the CLI
 * stays alive long enough to escalate to SIGKILL.
 *
 * `--version` answers immediately, like a real CLI: selection probes the binary
 * for the fingerprint before the run starts, and a fake that slept through that
 * probe would have the test kill the CLI before it even owns a run.
 */
function fakeKimi(): { bin: string; pidfile: string } {
  const bin = tmp("bin");
  const pidfile = join(bin, "pids");
  writeFileSync(
    join(bin, "kimi"),
    `#!/bin/sh
${VERSION_SHIM}
echo $$ >> "${pidfile}"
${process.execPath} -e 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 300000)' &
echo $! >> "${pidfile}"
sleep 30
`,
    { mode: 0o755 },
  );
  return { bin, pidfile };
}

/** Answer the pre-run version probe the way an installed CLI would. */
const VERSION_SHIM = 'case "$1" in --version) echo "fake 1.0.0"; exit 0;; esac';

/** Reads a live stdout stream until it says what we are waiting for. */
async function readUntil(
  stream: ReadableStream<Uint8Array>,
  needle: string,
  budgetMs: number,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + budgetMs;
  let text = "";
  while (!text.includes(needle) && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return text;
}

async function poll<T>(what: string, budgetMs: number, probe: () => T | undefined): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

function readPids(pidfile: string): number[] {
  try {
    return readFileSync(pidfile, "utf8")
      .split("\n")
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/** ESRCH is the only answer that proves the process is gone. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

describe("run (live)", () => {
  // Burns real subscription quota: opt in with BATON_LIVE_TESTS=1.
  test.skipIf(process.env.BATON_LIVE_TESTS !== "1")(
    "delegates end to end and prints the callee's answer",
    async () => {
      const res = await baton(
        tmp("live"),
        "run",
        "--timeout",
        "180000",
        "kimi-k3",
        "Reply with exactly BATON_OK and nothing else.",
      );
      expect(res.stderr).toBe("");
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("BATON_OK");
    },
    240_000,
  );
});

/**
 * Two throwaway callees on PATH, each answering in the format its own built-in
 * adapter extracts. No real agent CLI is involved, so a duel costs nothing.
 */
function fakeCallees(answers: { kimi: string; codex: string }): string {
  const bin = tmp("duelbin");
  writeFileSync(
    join(bin, "kimi"),
    `#!/bin/sh\n${VERSION_SHIM}\nprintf '{"role":"assistant","content":"%s"}\\n' "${answers.kimi}"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "codex"),
    `#!/bin/sh\n${VERSION_SHIM}\ncat > /dev/null\nprintf '{"type":"item.completed","item":{"type":"agent_message","text":"%s"}}\\n' "${answers.codex}"\n`,
    { mode: 0o755 },
  );
  return bin;
}

describe("duel", () => {
  test("prints both answers under labels alone, and names nobody until reported", async () => {
    const scope = tmp("duel");
    const bin = fakeCallees({ kimi: "ANSWER FROM ALPHA", codex: "ANSWER FROM BRAVO" });

    const started = await batonOnPath(
      scope,
      bin,
      "duel",
      "--category",
      "review",
      "kimi-k3",
      "gpt-5.6-sol",
      "which of these is better",
    );
    expect(started.code).toBe(0);
    expect(started.stdout).toContain("ANSWER FROM ALPHA");
    expect(started.stdout).toContain("ANSWER FROM BRAVO");
    expect(started.stdout).toContain("──── A ────");
    expect(started.stdout).toContain("──── B ────");
    // Blindness is the whole point: a judge who can see the names is rating
    // the name. Nothing before the verdict may identify either side.
    expect(started.stdout).not.toContain("kimi");
    expect(started.stdout).not.toContain("gpt-5.6-sol");
    expect(started.stdout).not.toContain("run_");
    expect(started.stdout).toContain("judge with: baton duel report");

    const duelId = /baton duel report (\S+)/.exec(started.stdout)?.[1] ?? "";
    expect(duelId).toStartWith("duel");

    const listed = await baton(scope, "duel", "list");
    expect(listed.stdout).toContain("awaiting_judgment");
    expect(listed.stdout).toContain("blind until judged");
    expect(listed.stdout).not.toContain("kimi-k3");

    const reported = await baton(scope, "duel", "report", duelId, "a");
    expect(reported.code).toBe(0);
    expect(reported.stdout).toContain("A was");
    expect(reported.stdout).toContain("kimi-k3");
    expect(reported.stdout).toContain("gpt-5.6-sol");

    // Judged duels are a separate signal in ratings, never blended into grades.
    const ratings = await baton(scope, "ratings");
    expect(ratings.stdout).toContain("Bradley-Terry");
    expect(ratings.stdout).toContain("kimi-k3");

    const after = await baton(scope, "duel", "list");
    expect(after.stdout).toContain("reported");
    expect(after.stdout).toMatch(/A=\S+ B=\S+/);
  }, 30_000);

  test("rejects the same model twice, an unknown duel, and a nonsense verdict", async () => {
    const scope = tmp("duel-bad");
    const same = await baton(scope, "duel", "kimi-k3", "kimi-k3", "hi");
    expect(same.code).toBe(1);
    expect(same.stderr).toContain("two different models");

    const verdict = await baton(scope, "duel", "report", "duel_x", "maybe");
    expect(verdict.code).toBe(2);
    expect(verdict.stderr).toContain("'A', 'B' or 'tie'");

    const unknown = await baton(scope, "duel", "report", "duel_x", "A");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("Unknown duel");

    expect((await baton(scope, "duel", "list")).stdout).toContain("No duels in this scope yet");
  });
});

/** A discovered spec, quarantined exactly as `register_app` would leave it. */
function seedDiscovered(
  scope: string,
  binary: string,
  opts: { status?: DiscoveredStatus; overrides?: Partial<AdapterSpec> } = {},
): AdapterSpec {
  mkdirSync(join(scope, "state"), { recursive: true, mode: 0o700 });
  const db = openStore(join(scope, "state", "baton.db"));
  const spec: AdapterSpec = {
    app: "fakeagent",
    adapterVersion: 1,
    binary,
    models: [{ model: "fake-1", slug: "fake/1" }],
    invoke: {
      argv: ["--model", "{slug}", "{autonomyFlags}"],
      promptVia: "stdin",
      extract: { kind: "json", path: "result" },
    },
    autonomyFlags: { readonly: ["--readonly"] },
    defaultAutonomy: "readonly",
    defaultTimeoutMs: 60_000,
    admissionFailurePatterns: [],
    ...opts.overrides,
  };
  db.query(
    `INSERT INTO discovered_adapters (app, spec, status, submitted_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (app) DO UPDATE SET
       spec = excluded.spec, status = excluded.status, submitted_at = excluded.submitted_at`,
  ).run(spec.app, canonicalSpecJson(spec), opts.status ?? "quarantined", nowIso());
  db.close();
  return spec;
}

/**
 * The CLI is otherwise tested as a subprocess, but approval refuses to run
 * without a terminal and a subprocess never has one. These two calls exercise
 * the handler in-process with the interactivity gate injected — the refusal
 * itself is asserted through the subprocess, where stdin really is not a tty.
 */
async function approveInteractively(
  scope: string,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const previous = process.env.BATON_CONFIG_DIR;
  process.env.BATON_CONFIG_DIR = scope;
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  console.log = (...parts: unknown[]): void => void out.push(parts.join(" "));
  console.error = (...parts: unknown[]): void => void err.push(parts.join(" "));
  try {
    const code = await adaptersApprove(args, { isInteractive: () => true });
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
    if (previous === undefined) delete process.env.BATON_CONFIG_DIR;
    else process.env.BATON_CONFIG_DIR = previous;
  }
}

/** The digest a human would have copied out of `baton adapters review`. */
function digestOf(spec: AdapterSpec): string {
  return shortDigest(specDigest(spec));
}

/** The discovered app's binary: answers with the token it was asked for. */
function fakeAgentBinary(): string {
  const path = join(tmp("agentbin"), "fakeagent");
  writeFileSync(
    path,
    `#!${process.execPath}
const prompt = await Bun.stdin.text();
const token = prompt.trim().split(/\\s+/).at(-1) ?? "";
await Bun.write(Bun.stdout, JSON.stringify({ result: token, argv: process.argv.slice(2) }));
`,
    { mode: 0o755 },
  );
  return path;
}

describe("adapters review and approval", () => {
  test("review prints the exact mechanics, approval canaries it into active", async () => {
    const scope = tmp("adapters");
    const binary = fakeAgentBinary();
    const spec = seedDiscovered(scope, binary);

    const quarantined = await baton(scope, "adapters", "list");
    expect(quarantined.stdout).toContain("fakeagent");
    expect(quarantined.stdout).toContain("quarantined");
    expect(quarantined.stdout).toContain("has been executed");

    const review = await baton(scope, "adapters", "review", "fakeagent");
    expect(review.code).toBe(0);
    expect(review.stdout).toContain(binary);
    // argv as a JSON array: where one element ends and the next begins is the
    // difference between one program and another.
    expect(review.stdout).toContain('["--model","{slug}","{autonomyFlags}"]');
    expect(review.stdout).toContain("prompt via: stdin");
    expect(review.stdout).toContain('JSON stdout, path "result"');
    expect(review.stdout).toContain("fake-1 → fake/1");
    expect(review.stdout).toContain(digestOf(spec));
    expect(review.stdout).toContain("Nothing from this spec has been executed");
    expect(review.stdout).toContain("Approve running this exact binary");
    // The review is honest about how far the terminal check reaches.
    expect(review.stdout).toContain("already holds full shell access");

    const approved = await approveInteractively(scope, "fakeagent", "--digest", digestOf(spec));
    expect(approved.code).toBe(0);
    expect(approved.stdout).toContain("Canary passed");
    expect((await baton(scope, "adapters", "list")).stdout).toContain("active");

    const rejected = await baton(scope, "adapters", "reject", "fakeagent", "changed", "my", "mind");
    expect(rejected.code).toBe(0);
    // Approval is consent to run one reviewed spec, and withdrawing it takes
    // execution rights back immediately.
    const refused = await baton(scope, "adapters", "canary", "fakeagent");
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain("failed");
    expect(refused.stderr).toContain("approval precedes execution");
  }, 30_000);

  test("approval refuses without a terminal, and without the reviewed digest", async () => {
    const scope = tmp("adapters-gate");
    const spec = seedDiscovered(scope, fakeAgentBinary());

    // A tool call or a pasted command has no terminal behind it. This is the
    // whole reason approval is not an MCP tool.
    const noTty = await baton(scope, "adapters", "approve", "fakeagent", "--digest", digestOf(spec));
    expect(noTty.code).toBe(1);
    expect(noTty.stderr).toContain("stdin is not a terminal");
    expect(noTty.stderr).toContain("no override flag");

    const noDigest = await baton(scope, "adapters", "approve", "fakeagent");
    expect(noDigest.code).toBe(2);
    expect(noDigest.stderr).toContain("--digest");

    // Right terminal, wrong spec: the digest is what makes approval a statement
    // about content instead of about an app name.
    const wrong = await approveInteractively(scope, "fakeagent", "--digest", "0".repeat(12));
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain("digest mismatch");

    // Nothing has been approved and nothing has been executed.
    expect((await baton(scope, "adapters", "list")).stdout).toContain("quarantined");
  });

  test("approving a digest the agent has already replaced is refused", async () => {
    const scope = tmp("adapters-swap");
    const binary = fakeAgentBinary();
    const reviewed = seedDiscovered(scope, binary);
    // Between the human reading the review and typing approve, the agent
    // resubmits — same app name, different argv.
    seedDiscovered(scope, binary, {
      overrides: { adapterVersion: 2, autonomyFlags: { readonly: ["--readonly", "--trust-all"] } },
    });

    const res = await approveInteractively(scope, "fakeagent", "--digest", digestOf(reviewed));
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("not approving what you reviewed");
    expect((await baton(scope, "adapters", "list")).stdout).toContain("quarantined");
  });

  test("--no-canary approves without executing anything", async () => {
    const scope = tmp("adapters-nocanary");
    const spec = seedDiscovered(scope, fakeAgentBinary());
    const res = await approveInteractively(
      scope,
      "fakeagent",
      "--digest",
      digestOf(spec),
      "--no-canary",
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Not active yet");
    const list = await baton(scope, "adapters", "list");
    expect(list.stdout).toMatch(/fakeagent\s+discovered\s+approved/);
  });

  test("the canary fails an adapter that returns the token inside other text", async () => {
    const scope = tmp("adapters-echo");
    // Extraction that hands back the whole prompt "contains" the token and has
    // verified nothing about the declared path.
    const path = join(tmp("echobin"), "echoagent");
    writeFileSync(
      path,
      `#!${process.execPath}
const prompt = await Bun.stdin.text();
await Bun.write(Bun.stdout, JSON.stringify({ result: "The agent says: " + prompt.trim() }));
`,
      { mode: 0o755 },
    );
    seedDiscovered(scope, path, { status: "approved" });

    const res = await baton(scope, "adapters", "canary", "fakeagent");
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("instead of BATON_CANARY");
    expect((await baton(scope, "adapters", "list")).stdout).not.toContain("active");
  }, 30_000);

  test("an active discovered adapter is a known app for settings, and its ceiling clamps", async () => {
    const scope = tmp("adapters-ceiling");
    // A fake that reports the argv it was actually spawned with.
    const path = join(tmp("argvbin"), "argvagent");
    writeFileSync(
      path,
      `#!${process.execPath}
await Bun.stdin.text();
await Bun.write(Bun.stdout, JSON.stringify({ result: process.argv.slice(2).join(" ") }));
`,
      { mode: 0o755 },
    );
    seedDiscovered(scope, path, {
      status: "active",
      overrides: {
        autonomyFlags: { readonly: ["--readonly"], full: ["--full"] },
        defaultAutonomy: "full",
      },
    });

    const set = await baton(scope, "set", "max_autonomy:fakeagent", "readonly");
    expect(set.code).toBe(0);
    expect(set.stdout).toContain("max_autonomy:fakeagent = readonly");

    // The ceiling is not decoration: a run that asks for more gets less.
    const run = await baton(scope, "run", "fake-1", "hello", "--autonomy", "full");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("--readonly");
    expect(run.stdout).not.toContain("--full");
  }, 30_000);

  test("a review of an app this scope never heard of fails without guessing", async () => {
    const res = await baton(tmp("adapters-unknown"), "adapters", "review", "ghost");
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("no discovered adapter 'ghost'");
  });
});

describe("adapters canary --all (conformance suite)", () => {
  test("--structural validates every built-in without executing one", async () => {
    const scope = tmp("conformance");
    // Every built-in binary is a fake that records having been run: the marker
    // is what proves the structural half really executes nothing.
    const bin = tmp("conformance-bin");
    const marker = join(bin, "ran");
    for (const app of ["codex", "kimi", "claude", "opencode", "cursor-agent"]) {
      writeFileSync(join(bin, app), `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 });
    }
    seedDiscovered(scope, fakeAgentBinary());

    const res = await batonOnPath(scope, bin, "adapters", "canary", "--all", "--structural");
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("STRUCTURE");
    expect(res.stdout).toMatch(/codex\s+builtin\s+ok/);
    expect(res.stdout).toMatch(/kimi\s+builtin\s+ok/);
    expect(res.stdout).toMatch(/fakeagent\s+quarantined\s+ok/);
    expect(res.stdout).toContain("not run (--structural)");
    expect(existsSync(marker)).toBe(false);
  });

  test("a built-in whose answer merely contains the token fails the canary", async () => {
    const scope = tmp("conformance-loose");
    const bin = tmp("conformance-loose-bin");
    // Answers in codex's own JSONL shape, so extraction succeeds — and returns
    // the token wrapped in prose, which is not what the canary asked for.
    writeFileSync(
      join(bin, "codex"),
      `#!/bin/sh\necho '{"type":"item.completed","item":{"type":"agent_message","text":"Sure thing: BATON_CANARY"}}'\n`,
      { mode: 0o755 },
    );

    const res = await batonOnPath(scope, bin, "adapters", "canary", "codex");
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("instead of BATON_CANARY");
  }, 30_000);

  test("an adapter nobody has heard of is a usage error, not an empty pass", async () => {
    const res = await baton(tmp("conformance-unknown"), "adapters", "canary", "ghost");
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("unknown adapter 'ghost'");
  });

  // The live half runs every installed agent CLI for real: opt in with
  // BATON_LIVE_TESTS=1.
  test.skipIf(process.env.BATON_LIVE_TESTS !== "1")(
    "runs a real canary against every installed built-in",
    async () => {
      const res = await baton(tmp("conformance-live"), "adapters", "canary", "--all");
      expect(res.stdout).toContain("passed");
      expect(res.code).toBe(0);
    },
    600_000,
  );
});

describe("profile export", () => {
  test("round-trips through profile import, canonical priors only", async () => {
    const source = tmp("export-source");
    const file = join(tmp("export-file"), "team.yaml");
    writeFileSync(file, PROFILE_FILE);
    await baton(source, "profile", "import", file, "--yes", "--activate");

    const printed = await baton(source, "profile", "export");
    expect(printed.code).toBe(0);
    expect(printed.stdout).toContain("name: team");
    expect(printed.stdout).toContain("kimi-k3");
    // The portability guarantee, stated where a reader of the file will see it.
    expect(printed.stdout).toContain("portable priors only");

    const out = join(tmp("export-out"), "exported.yaml");
    const written = await baton(source, "profile", "export", "--out", out);
    expect(written.stdout).toContain("2 priors");
    // Everything but the export stamp, which is the moment of writing.
    expect(priorLines(readFileSync(out, "utf8"))).toEqual(priorLines(printed.stdout));

    // Into a scope that has never seen this profile: same two entries.
    const target = tmp("export-target");
    const imported = await baton(target, "profile", "import", out, "--yes", "--activate");
    expect(imported.code).toBe(0);
    expect(imported.stdout).toContain("2 added, 0 changed, 0 unchanged");
    expect(priorLines((await baton(target, "profile", "export")).stdout)).toEqual(
      priorLines(printed.stdout),
    );

    // And back into the scope it came from: nothing moved.
    const again = await baton(source, "profile", "import", out);
    expect(again.stdout).toContain("0 added, 0 changed, 2 unchanged");
  });

  /** The document minus `exported_at`: two exports differ only in that stamp. */
  function priorLines(text: string): string[] {
    return text.split("\n").filter((line) => !line.startsWith("exported_at:"));
  }

  test("says so when there is no profile to export", async () => {
    const scope = tmp("export-empty");
    const res = await baton(scope, "profile", "export");
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("no active one");

    const named = await baton(scope, "profile", "export", "--profile", "team");
    expect(named.code).toBe(1);
    expect(named.stderr).toContain("no priors to export");
  });
});

describe("resume", () => {
  test("continues the original run's session on the same adapter", async () => {
    const scope = tmp("resume");
    const runId = seedRun(scope, { succeeded: true, sessionRef: "session_abc" });
    const bin = tmp("resume-bin");
    // Echoes its own argv back as the answer, so the assertion can see the
    // session handle the adapter's resume template filled in.
    writeFileSync(
      join(bin, "kimi"),
      `#!/bin/sh\n${VERSION_SHIM}\nprintf '{"role":"assistant","content":"RESUMED %s"}\\n' "$*"\n`,
      { mode: 0o755 },
    );

    const res = await batonOnPath(scope, bin, "resume", runId, "and now the second turn");
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("RESUMED");
    expect(res.stdout).toContain("-S session_abc");
    expect(res.stdout).toContain("and now the second turn");
  }, 30_000);

  test("refuses an unknown run and a run with no session handle", async () => {
    const scope = tmp("resume-bad");
    const unknown = await baton(scope, "resume", "run_nope", "continue");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("Unknown run 'run_nope'");

    const handleless = seedRun(scope, { succeeded: true });
    const noHandle = await baton(scope, "resume", handleless, "continue");
    expect(noHandle.code).toBe(1);
    expect(noHandle.stderr).toContain("no session handle");

    expect((await baton(scope, "resume", handleless)).code).toBe(2);
  });
});

describe("serve --http", () => {
  test("needs --http, and rejects a stray argument", async () => {
    const scope = tmp("serve-usage");
    const bare = await baton(scope, "serve");
    expect(bare.code).toBe(2);
    expect(bare.stderr).toContain("serve needs --http");

    const stray = await baton(scope, "serve", "--http", "please");
    expect(stray.code).toBe(2);
    expect(stray.stderr).toContain("no positional arguments");
  });

  test.skipIf(!existsSync(HTTP_MODULE))(
    "serves this scope and reports where, until it is signalled",
    async () => {
      const scope = tmp("serve-up");
      const proc = Bun.spawn([process.execPath, ENTRY, "serve", "--http", "--port", "0"], {
        env: { ...process.env, BATON_CONFIG_DIR: scope, BATON_HOPS: undefined },
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const banner = await readUntil(proc.stdout, "url", 15_000);
      expect(banner).toContain("http://127.0.0.1:");
      // One daemon serves exactly one scope, because it inherits one environment.
      expect(banner).toContain(scope);

      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(0);
    },
    30_000,
  );

  // Skipped only while src/mcp/http.ts is unimplemented; without it the CLI
  // would "fail" for the wrong reason and the assertion would prove nothing.
  test.skipIf(!existsSync(HTTP_MODULE))(
    "fails gracefully when the port is already taken",
    async () => {
      const scope = tmp("serve-busy");
      // Same address the daemon binds: a wildcard holder would let it start.
      const holder = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("busy") });
      try {
        const res = await baton(scope, "serve", "--http", "--port", String(holder.port));
        // A daemon that cannot bind must say so and exit, not run half-alive.
        expect(res.code).toBe(1);
        expect(res.stderr).toContain("baton:");
        expect(res.stderr).not.toContain("Cannot find module");
      } finally {
        await holder.stop(true);
      }
    },
    30_000,
  );
});

describe("detect and unknown commands", () => {
  test("detect lists every builtin adapter and the models it serves", async () => {
    const res = await baton(tmp("detect"), "detect");
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("codex");
    expect(res.stdout).toContain("kimi");
    expect(res.stdout).toContain("gpt-5.6-luna");
  });

  test("an unknown subcommand prints usage to stderr and exits 2", async () => {
    const res = await baton(tmp("unknown"), "frobnicate");
    expect(res.code).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("unknown command 'frobnicate'");
    expect(res.stderr).toContain("Usage:");
  });
});

describe("runs (a side of an unjudged duel)", () => {
  test("masks the model and the route until the duel is judged", async () => {
    const scope = tmp("runs-blind");
    const bin = fakeCallees({ kimi: "ANSWER FROM ALPHA", codex: "ANSWER FROM BRAVO" });
    const started = await batonOnPath(
      scope,
      bin,
      "duel",
      "kimi-k3",
      "gpt-5.6-sol",
      "which of these is better",
    );
    expect(started.code).toBe(0);
    const duelId = /baton duel report (\S+)/.exec(started.stdout)?.[1] ?? "";
    expect(duelId).toStartWith("duel");

    // `baton runs` is the back door into a duel: the run rows carry the model
    // and the route the labels exist to hide.
    const list = await baton(scope, "runs");
    expect(list.stdout).not.toContain("kimi-k3");
    expect(list.stdout).not.toContain("gpt-5.6-sol");
    expect(occurrences(list.stdout, `duel ${duelId} (blind)`)).toBe(2);

    const runId = /run_\S+/.exec(list.stdout)?.[0] ?? "";
    const detail = await baton(scope, "runs", runId);
    expect(detail.code).toBe(0);
    expect(detail.stdout).toContain(`duel ${duelId} (blind)`);
    // The answer is still readable — judging needs it; the identity is not.
    expect(detail.stdout).toContain("ANSWER FROM ");
    expect(detail.stdout).not.toContain("kimi");
    expect(detail.stdout).not.toContain("codex");
    expect(detail.stdout).not.toContain("@a");

    // Judging is the reveal, and it un-blinds the runs with it.
    expect((await baton(scope, "duel", "report", duelId, "A")).code).toBe(0);
    const after = await baton(scope, "runs", runId);
    expect(after.stdout).toMatch(/kimi-k3|gpt-5\.6-sol/);
    expect(after.stdout).not.toContain("(blind)");
    expect((await baton(scope, "runs")).stdout).not.toContain("(blind)");
  }, 30_000);
});
