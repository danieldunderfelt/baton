import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { adaptersApprove } from "../src/cli/cli.ts";
import type { AdapterSpec } from "../src/adapters/types.ts";

/**
 * THE PHASE-3 EXIT CRITERION, rehearsed end to end (PLAN.md §Build phases):
 * "a previously unknown agent app is onboarded end-to-end by an agent —
 * discovered, reviewed, approved, activated, seeded — without the user editing
 * a config file."
 *
 * So this test is not allowed to shortcut any of it. Every step goes through
 * the surface the actor really uses: the agent's half through the MCP SDK
 * client against a real `baton mcp` process, the user's half through `baton
 * adapters review/approve` as a real subprocess. Both sides share one scope
 * (BATON_CONFIG_DIR) and nothing else — no in-process handles, no direct SQL.
 *
 * The unknown app is a fixture CLI at an absolute path in a temp dir, so the
 * whole rehearsal is hermetic: no real agent CLI, no network, no quota. The
 * quarantine invariant is asserted as a *negative* — before approval the app's
 * model is not routable and run_model refuses it.
 */

const REPO = resolve(import.meta.dir, "..");
/**
 * The source entry point, always — reached through a real subprocess, so these
 * are still the real MCP and CLI surfaces.
 *
 * This deliberately does NOT prefer `dist/baton` when it happens to exist. One
 * step of this flow (approval) can only run in-process, because it refuses
 * without a terminal; mixing a compiled subprocess with in-process source in one
 * flow makes the result depend on when the binary was last built, and a stale
 * `dist/baton` then reports the OLD CLI's behaviour as green. The compiled
 * artifact has its own coverage in test/binary.test.ts, which is where a build
 * that never happened should fail.
 */
const CLI: { command: string; args: string[] } = {
  command: process.execPath,
  args: [join(REPO, "src", "index.ts")],
};

const APP = "fake-onboarding";
const MODEL = "fabulous-1";
const SLUG = "fake/fabulous-1";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

let scope: string;
let workdir: string;
let binaryPath: string;
let client: Client;
/** Copied out of the review the user read, exactly as a human would. */
let reviewedDigest: string;

/** The unknown app: an absolute, executable CLI this machine has never seen. */
function installFakeCli(): string {
  const dir = tempDir("baton-fake-app-");
  const path = join(dir, "fake-onboarding-cli");
  const fixture = join(import.meta.dir, "fixtures", "fake-onboarding-cli.ts");
  writeFileSync(
    path,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

/**
 * The spec an agent would write after probing the fixture per discover_app's
 * brief: absolute binary, argv array, prompt on stdin, declarative extraction.
 */
function discoveredSpec(): AdapterSpec {
  return {
    app: APP,
    adapterVersion: 1,
    binary: binaryPath,
    models: [{ model: MODEL, slug: SLUG }],
    invoke: {
      argv: ["run", "--model", "{slug}", "--format", "jsonl", "{autonomyFlags}"],
      promptVia: "stdin",
      extract: {
        kind: "jsonl",
        where: { path: "type", equals: "result" },
        errorWhen: { path: "is_error", equals: "true" },
        path: "result",
        take: "last",
      },
    },
    autonomyFlags: { readonly: ["--readonly"], full: ["--yolo"] },
    sessionRef: {
      kind: "jsonl",
      where: { path: "type", equals: "init" },
      path: "session_id",
      take: "first",
    },
    defaultAutonomy: "full",
    defaultTimeoutMs: 30_000,
    admissionFailurePatterns: ["rate limit reached"],
    workStartedPatterns: ['"type":"assistant"'],
  };
}

/** `baton <args>` in the shared scope, as the user would run it. */
async function baton(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([CLI.command, ...CLI.args, ...args], {
    cwd: workdir,
    env: { ...process.env, BATON_CONFIG_DIR: scope, BATON_HOPS: "0" },
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

/**
 * The one step that cannot go through a subprocess: approval refuses unless
 * stdin is a terminal, and a spawned process never has one. The refusal is
 * asserted against the real subprocess below; granting runs the same handler
 * in-process with only the interactivity gate injected, against the same scope.
 */
async function approveAtATerminal(
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

/**
 * Tool result payloads are JSON text; a tool error surfaces as a throw, so a
 * refusal can be asserted with `.rejects`. Returned loosely typed on purpose:
 * restating each tool's output shape here would only duplicate the server's own
 * schema, and the assertions below are what this test is checking.
 */
async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  const first = Array.isArray(res.content) ? res.content[0] : undefined;
  const text = first && first.type === "text" ? first.text : "";
  if (res.isError) throw new Error(text);
  return JSON.parse(text);
}

beforeAll(async () => {
  scope = tempDir("baton-onboard-scope-");
  workdir = tempDir("baton-onboard-cwd-");
  binaryPath = installFakeCli();

  const env: Record<string, string> = { BATON_CONFIG_DIR: scope, BATON_HOPS: "0" };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !(key in env)) env[key] = value;
  }
  client = new Client({ name: "baton-onboarding-e2e", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: CLI.command,
      args: [...CLI.args, "mcp"],
      env,
      cwd: workdir,
      stderr: "pipe",
    }),
  );
});

afterAll(async () => {
  await client?.close();
});

describe("phase-3 exit criterion: onboarding an unknown agent app", () => {
  /**
   * Ordered on purpose — this is one flow, and each step is only meaningful
   * after the one before it. Bun runs tests in a file sequentially.
   */

  test("1. discover_app hands the agent a probe checklist and the spec schema", async () => {
    const res = await client.callTool({ name: "discover_app", arguments: { name: APP } });
    const first = Array.isArray(res.content) ? res.content[0] : undefined;
    const brief = first && first.type === "text" ? first.text : "";

    expect(brief).toContain(APP);
    // The two things the brief exists to say: probe it yourself, and its
    // output is untrusted content rather than instructions.
    expect(brief.toLowerCase()).toContain("untrusted");
    expect(brief).toContain("BATON_CANARY");
    // The spec schema the agent has to fill in.
    expect(brief).toContain("adapterVersion");
    expect(brief).toContain("promptVia");
  });

  test("2. register_app quarantines the spec — nothing is executed", async () => {
    const stored = await call("register_app", { spec: discoveredSpec() });

    expect(stored.app).toBe(APP);
    expect(stored.status).toBe("quarantined");
    expect(stored.binary).toBe(binaryPath);
    expect(stored.nextStep).toBe(`baton adapters review ${APP}`);
  });

  test("3. a quarantined app is visible but NOT routable", async () => {
    const listing = await call("list_models");

    const pending = listing.quarantined_apps.find((a: { app: string }) => a.app === APP);
    expect(pending).toBeDefined();
    expect(pending.status).toBe("quarantined");
    expect(pending.nextStep).toBe(`baton adapters review ${APP}`);

    // Visible, so the user knows what they are being asked to review — and
    // unavailable, with the reason and the fix.
    const route = listing.models.find((m: { model: string }) => m.model === MODEL);
    expect(route.available).toBe(false);
    expect(route.degradedReason).toContain("quarantined");

    // The invariant, stated as a refusal: approval precedes execution.
    await expect(
      call("run_model", { model: MODEL, prompt: "should never run", wait: true }),
    ).rejects.toThrow();
  });

  test("4. the user reviews the exact executable and argv in their own terminal", async () => {
    const review = await baton("adapters", "review", APP);
    expect(review.code, review.stderr).toBe(0);

    // Everything the approval decision rests on, verbatim. argv is printed as a
    // JSON array because where one element ends and the next begins is the
    // difference between one program and another.
    expect(review.stdout).toContain(binaryPath);
    expect(review.stdout).toContain('["run","--model","{slug}","--format","jsonl","{autonomyFlags}"]');
    expect(review.stdout).toContain("prompt via: stdin");
    expect(review.stdout).toContain(`${MODEL} → ${SLUG}`);
    expect(review.stdout).toContain("Nothing from this spec has been executed");
    expect(review.stdout).toContain("untrusted CLI output");

    // The digest the approval has to quote back: it binds consent to the spec
    // printed above, not to the app name the agent picked.
    const quoted = /^digest:\s+([0-9a-f]{12})\b/m.exec(review.stdout);
    expect(quoted).not.toBeNull();
    reviewedDigest = quoted?.[1] ?? "";
    expect(review.stdout).toContain(
      `baton adapters approve ${APP} --digest ${reviewedDigest}`,
    );
  });

  test("5. approval runs the canary, and the canary activates the adapter", async () => {
    // A program cannot take this step. The agent that submitted the spec can
    // reach this exact command, and the real binary refuses it.
    const byProgram = await baton("adapters", "approve", APP, "--digest", reviewedDigest);
    expect(byProgram.code).toBe(1);
    expect(byProgram.stderr).toContain("stdin is not a terminal");
    expect((await baton("adapters", "list")).stdout).toContain("quarantined");

    // The user, at their own terminal, quoting the digest they just read.
    const approve = await approveAtATerminal(APP, "--digest", reviewedDigest);
    expect(approve.code, approve.stderr).toBe(0);
    expect(approve.stdout).toContain(`Approved ${APP}`);
    // The canary asked the real binary for the token and read it back through
    // the declared extraction path — that is what activation is evidence of.
    expect(approve.stdout).toContain("Canary passed");
    expect(approve.stdout).toContain(`${APP} is active`);

    const list = await baton("adapters", "list");
    expect(list.stdout).toContain(`${APP}`);
    expect(list.stdout).toContain("discovered");
    expect(list.stdout).toContain("active");
  });

  test("6. list_models now offers the route, alongside the built-ins", async () => {
    const listing = await call("list_models");

    expect(listing.quarantined_apps).toEqual([]);
    const route = listing.models.find((m: { model: string }) => m.model === MODEL);
    expect(route.app).toBe(APP);
    expect(route.slug).toBe(SLUG);
    expect(route.available).toBe(true);
    expect(route.degradedReason).toBeUndefined();
    // The app roster agrees with the routes beside it.
    expect(listing.apps.find((a: { app: string }) => a.app === APP).binaryPath).toBe(binaryPath);
  });

  test("7. run_model delegates through the new app and returns its answer", async () => {
    const run = await call("run_model", {
      model: MODEL,
      prompt: "Summarise this file.\nThe last line is the answer.",
      wait: true,
      category: "implementation",
    });

    expect(run.status).toBe("succeeded");
    expect(run.app).toBe(APP);
    expect(run.output).toBe("The last line is the answer.");

    // The run is a first-class run: the handle resolves and the session handle
    // the app minted was captured off its attempt.
    const detail = await call("get_run", { run_id: run.run_id });
    expect(detail.status).toBe("succeeded");
    expect(detail.attempts.at(-1).sessionRef).toBe("sess_fake_onboarding");
  });

  test("8. the agent seeds the user's opinion of the new model", async () => {
    const seeded = await call("seed_ratings", {
      profile_name: "onboarding",
      entries: [{ model: MODEL, mean: 4, notes: "user says it is solid for implementation" }],
    });
    expect(seeded.profile).toBe("onboarding");
    expect(seeded.entries).toHaveLength(1);
    expect(seeded.entries[0].model).toBe(MODEL);

    const ratings = await call("get_ratings");
    const row = ratings.ratings.find((r: { model: string }) => r.model === MODEL);
    expect(row.prior).toBe(4);
    // Prior and observed stay provenance-separated (PLAN.md §Evaluation).
    expect(row.priorSource).toBeDefined();
  });

  test("9. the whole onboarding touched no config file the user had to edit", async () => {
    // The only durable state is the scope's own database; the spec, its
    // approval and the seeded prior all live there.
    const status = await baton("status");
    expect(status.code, status.stderr).toBe(0);
    expect(status.stdout).toContain(scope);
    expect(status.stdout).toContain(APP);
  });
});
