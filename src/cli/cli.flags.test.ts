import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Flag-surface regressions found in review: instance `--env` values
 * were stored with a literal `~`, and `run --no-wait` promised a detachment the
 * CLI cannot deliver. Subprocess round-trips, throwaway scope, no callee runs.
 */

const ENTRY = resolve(import.meta.dir, "..", "index.ts");

describe("help and argument validation", () => {
  for (const args of [[], ["--help"], ["help", "install"], ["install", "--user", "--help"],
    ["update", "--help"], ["upgrade", "-h"], ["mcp", "--help"], ["profile", "share", "--help"]]) {
    test(`baton ${args.join(" ")} prints help without side effects`, async () => {
      const dir = tmp("help");
      const config = join(dir, "state");
      const res = await baton({ BATON_CONFIG_DIR: config }, ...args);
      expect(res.code, res.stderr).toBe(0);
      expect(res.stdout).toContain("baton install [host...] [--user]");
      expect(res.stdout).toContain("baton update");
      expect(res.stdout).toContain("baton block");
      expect(existsSync(config)).toBe(false);
    });
  }
  for (const args of [["update", "--typo"], ["upgrade", "oops"], ["mcp", "--typo"],
    ["status", "--typo"], ["models", "oops"], ["detect", "oops"], ["nonsense", "--help"],
    ["help", "nonsense"], ["install", "--user=false"], ["install", "--dir", "--user"],
    ["set", "max_hops", "2", "oops"]]) {
    test(`baton ${args.join(" ")} rejects invalid arguments`, async () => {
      const res = await baton({ BATON_CONFIG_DIR: tmp("bad-args") }, ...args);
      expect(res.code, res.stdout).toBe(2);
    });
  }
  test("-- makes help text a literal prompt", async () => {
    const res = await baton({ BATON_CONFIG_DIR: tmp("literal-help") }, "run", "unknown-model", "--", "--help");
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("Unknown model");
    expect(res.stdout).not.toContain("Usage:");
  });
});

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `baton-cli-${prefix}-`));
}

async function baton(
  env: Record<string, string | undefined>,
  ...args: string[]
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

describe("instance add --env", () => {
  test("expands a leading ~ so the stored value is the path the callee will use", async () => {
    const scope = tmp("env-home");
    const home = tmp("env-fakehome");
    const env = { BATON_CONFIG_DIR: scope, HOME: home };

    const add = await baton(
      env,
      "instance",
      "add",
      "kimi",
      "personal-2",
      "--env",
      "KIMI_CODE_HOME=~/.kimi-personal2",
    );
    expect(add.code).toBe(0);
    expect(add.stdout).toContain(join(home, ".kimi-personal2"));
    expect(add.stdout).not.toContain("~/");

    const list = await baton(env, "instance", "list");
    expect(list.stdout).toContain(`KIMI_CODE_HOME=${join(home, ".kimi-personal2")}`);
  });

  test("leaves values without a leading ~ alone", async () => {
    const scope = tmp("env-plain");
    const home = tmp("env-plainhome");
    const env = { BATON_CONFIG_DIR: scope, HOME: home };
    await baton(env, "instance", "add", "kimi", "work", "--env", "KIMI_CODE_HOME=/srv/kimi~work");
    const list = await baton(env, "instance", "list");
    expect(list.stdout).toContain("KIMI_CODE_HOME=/srv/kimi~work");
  });
});

describe("run flags", () => {
  test("--no-wait is gone: the CLI cannot detach from a run it supervises", async () => {
    const res = await baton({ BATON_CONFIG_DIR: tmp("nowait") }, "run", "--no-wait", "kimi-k3", "hi");
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("unknown flag '--no-wait'");
  });

  test("the usage text no longer advertises it", async () => {
    const res = await baton({ BATON_CONFIG_DIR: tmp("usage") }, "frobnicate");
    expect(res.stderr).toContain("Usage:");
    expect(res.stderr).not.toContain("--no-wait");
  });
});

describe("set max_concurrent", () => {
  test("round-trips a positive integer and rejects anything else", async () => {
    const env = { BATON_CONFIG_DIR: tmp("concurrent") };
    const ok = await baton(env, "set", "max_concurrent", "2");
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("max_concurrent = 2");
    expect((await baton(env, "set", "max_concurrent", "0")).code).toBe(2);
  });

  test("is listed among the valid keys", async () => {
    const res = await baton({ BATON_CONFIG_DIR: tmp("keys") }, "set", "nonsense", "1");
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("max_concurrent");
  });
});
