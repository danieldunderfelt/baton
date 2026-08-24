import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The CLI is tested as a subprocess: exit codes and the two streams are its
 * contract. Every run gets a throwaway BATON_CONFIG_DIR, so nothing here can
 * touch the developer's real scope, and no test invokes a callee CLI.
 */

const ENTRY = resolve(import.meta.dir, "..", "index.ts");

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `baton-cli-${prefix}-`));
}

async function baton(
  scope: string,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "run", ENTRY, ...args], {
    env: { ...process.env, BATON_CONFIG_DIR: scope, BATON_HOPS: undefined },
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
    expect(res.stdout).toMatch(/OPENCODE_CONFIG_DIR\s+\(unset\)/);
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
 */
function fakeKimi(): { bin: string; pidfile: string } {
  const bin = tmp("bin");
  const pidfile = join(bin, "pids");
  writeFileSync(
    join(bin, "kimi"),
    `#!/bin/sh
echo $$ >> "${pidfile}"
${process.execPath} -e 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 300000)' &
echo $! >> "${pidfile}"
sleep 30
`,
    { mode: 0o755 },
  );
  return { bin, pidfile };
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
