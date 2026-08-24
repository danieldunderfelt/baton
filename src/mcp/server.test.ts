import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Black-box: spawns the real `baton mcp` process and talks to it over stdio
 * with the SDK client, so transport, schema generation and dispatch are all
 * exercised as a host would. BATON_CONFIG_DIR points at a temp scope, so the
 * tests never touch the developer's real registry, settings or run history.
 */

const ENTRY = resolve(import.meta.dir, "../index.ts");
const LIVE = Bun.env.BATON_LIVE_TESTS === "1";

interface Session {
  client: Client;
  dir: string;
  close: () => Promise<void>;
}

/** `hops` seeds BATON_HOPS so the recursion guard's state is explicit, not inherited. */
async function connect(hops = "0", overrides: Record<string, string> = {}): Promise<Session> {
  const dir = mkdtempSync(join(tmpdir(), "baton-mcp-"));
  const env: Record<string, string> = { BATON_CONFIG_DIR: dir, BATON_HOPS: hops };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "BATON_CONFIG_DIR" && key !== "BATON_HOPS") env[key] = value;
  }
  Object.assign(env, overrides);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY, "mcp"],
    env,
    cwd: dir,
    stderr: "pipe",
  });
  const client = new Client({ name: "baton-test", version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    dir,
    close: async () => {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; text: string }> {
  const res = await client.callTool({ name, arguments: args });
  const first = Array.isArray(res.content) ? res.content[0] : undefined;
  const text = first && first.type === "text" ? first.text : "";
  return { isError: res.isError === true, text };
}

async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const { isError, text } = await call(client, name, args);
  expect(isError, text).toBe(false);
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * A throwaway `kimi` for PATH: it records its own pid and a grandchild's, then
 * sleeps. The grandchild ignores SIGTERM, so the group only dies if someone
 * stays alive long enough to escalate to SIGKILL.
 */
function fakeKimi(): { bin: string; pidfile: string } {
  const bin = mkdtempSync(join(tmpdir(), "baton-mcp-bin-"));
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

let session: Session;

beforeAll(async () => {
  session = await connect();
}, 30_000);

afterAll(async () => {
  await session?.close();
});

describe("tools/list", () => {
  test("exposes exactly the phase-1 tool set with usable schemas", async () => {
    const { tools } = await session.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_run", "list_models", "run_model"]);

    for (const tool of tools) {
      expect(tool.description ?? "").not.toBe("");
      expect(tool.inputSchema.type).toBe("object");
    }

    const runModel = tools.find((t) => t.name === "run_model")!;
    const props = runModel.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual([
      "category",
      "cwd",
      "idempotency_key",
      "instance",
      "model",
      "options",
      "prompt",
      "wait",
    ]);
    expect((runModel.inputSchema.required as string[]).sort()).toEqual(["model", "prompt"]);
    expect(props.wait).toMatchObject({ type: "boolean", default: true });
    // The caller-facing contract lives in the description; agents route on it.
    expect(runModel.description).toContain("idempotency_key");
    expect(runModel.description).toContain("get_run");
    // A key reused for a changed payload errors, and the cap is a tool error the
    // caller has to back off from rather than retry — both must be stated.
    expect(runModel.description).toContain("payload-bound");
    expect(runModel.description).toContain("max_concurrent");

    const listModels = tools.find((t) => t.name === "list_models")!;
    expect(listModels.description).toContain("degradedReason");
    // ttlMs is a caller-side hint; nothing is cached server-side.
    expect(listModels.description).toMatch(/Nothing is cached server-side/);

    const getRun = tools.find((t) => t.name === "get_run")!;
    expect((getRun.inputSchema.required as string[])).toEqual(["run_id"]);
  });
});

describe("list_models", () => {
  test("reports the built-in routes, availability and the active scope", async () => {
    const payload = await callJson(session.client, "list_models");

    expect(payload.scope).toEqual({ scoped: true, configDir: session.dir });
    expect(payload.ttlMs).toBeGreaterThan(0);

    const models = payload.models as { model: string; app: string; slug: string }[];
    expect(models).toContainEqual(
      expect.objectContaining({ model: "kimi-k3", app: "kimi", slug: "kimi-code/k3" }),
    );
    expect(models).toContainEqual(
      expect.objectContaining({ model: "gpt-5.6-sol", app: "codex", slug: "gpt-5.6-sol" }),
    );
    for (const entry of models) expect(entry).toHaveProperty("available");

    // Deterministic order: model asc, then app asc.
    const keys = models.map((m) => `${m.model}\u0000${m.app}`);
    expect(keys).toEqual([...keys].sort());

    const apps = payload.apps as { app: string }[];
    expect(apps.map((a) => a.app)).toEqual(["codex", "kimi"]);
  });

  test("an unusable route says why, in degradedReason", async () => {
    const blind = await connect("0", { PATH: "/nonexistent-baton-test" });
    try {
      const payload = await callJson(blind.client, "list_models");
      const models = payload.models as { available: boolean; degradedReason?: string }[];
      expect(models.length).toBeGreaterThan(0);
      for (const entry of models) {
        expect(entry.available).toBe(false);
        expect(entry.degradedReason).toContain("binary not found");
      }
    } finally {
      await blind.close();
    }
  }, 30_000);
});

describe("get_run", () => {
  test("a bogus handle is a clean tool error, not a crash", async () => {
    const { isError, text } = await call(session.client, "get_run", { run_id: "run_nope" });
    expect(isError).toBe(true);
    expect(text).toContain("run_nope");
    expect(text).toContain(session.dir);
  });

  test("a missing argument fails validation before reaching the store", async () => {
    const { isError, text } = await call(session.client, "get_run");
    expect(isError).toBe(true);
    expect(text).toContain("run_id");
  });
});

describe("run_model", () => {
  test("an unknown model is a tool error listing what this scope knows", async () => {
    const { isError, text } = await call(session.client, "run_model", {
      model: "no-such-model",
      prompt: "hello",
      wait: false,
    });
    expect(isError).toBe(true);
    expect(text).toContain("no-such-model");
    expect(text).toContain("kimi-k3");
  });

  test("delegation past the hop limit is refused before anything is spawned", async () => {
    const deep = await connect("2");
    try {
      const { isError, text } = await call(deep.client, "run_model", {
        model: "kimi-k3",
        prompt: "should never run",
        wait: false,
      });
      expect(isError).toBe(true);
      expect(text).toContain("BATON_HOPS");
    } finally {
      await deep.close();
    }
  }, 30_000);
});

describe("shutdown", () => {
  test("the transport going away kills the callee's process group", async () => {
    const { bin, pidfile } = fakeKimi();
    const host = await connect("0", { PATH: `${bin}:${process.env.PATH ?? ""}` });

    const started = await callJson(host.client, "run_model", {
      model: "kimi-k3",
      prompt: "sleep for a while",
      wait: false,
    });
    expect(started.status).toBe("running");
    // Both the callee and its grandchild: a group kill is the only thing that
    // reaches the second one.
    const pids = await poll("the fake callee to spawn", 15_000, () => {
      const found = readPids(pidfile);
      return found.length >= 2 ? found : undefined;
    });

    await host.close();

    await poll("the callee's process group to die", 15_000, () =>
      pids.every((pid) => !alive(pid)) ? true : undefined,
    );
  }, 45_000);
});

// --- Live: spawns a real agent CLI and spends real subscription quota. -------

describe.skipIf(!LIVE)("live delegation", () => {
  test("runs, dedupes on the idempotency key, and is pollable by handle", async () => {
    const key = `test-${crypto.randomUUID()}`;
    const args = {
      model: "kimi-k3",
      prompt: "Reply with exactly BATONOK and nothing else.",
      wait: true,
      idempotency_key: key,
      options: { timeoutMs: 120_000 },
    };

    const first = await callJson(session.client, "run_model", args);
    expect(first.status).toBe("succeeded");
    expect(String(first.output)).toContain("BATONOK");

    const retry = await callJson(session.client, "run_model", args);
    expect(retry.run_id).toBe(first.run_id);
    expect(retry.deduplicated).toBe(true);

    const view = await callJson(session.client, "get_run", { run_id: first.run_id });
    expect(view.runId).toBe(first.run_id);
    expect(view.status).toBe("succeeded");
    expect((view.attempts as unknown[]).length).toBe(1);
  }, 300_000);
});
