import { expect, test } from "bun:test";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { AdapterSpec } from "../src/adapters/types.ts";

/** Exercises the public MCP flow using a fake executable and a fresh scope. */
test("an unknown app can register, run, disable, enable and record preferences without a terminal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "baton-onboarding-"));
  const invocations = join(dir, "executions");
  const binary = join(dir, "fake-onboarding-cli");
  const fixture = join(import.meta.dir, "fixtures", "fake-onboarding-cli.ts");
  writeFileSync(binary, `#!/bin/sh
if [ "$1" != "--version" ]; then echo execution >> ${JSON.stringify(invocations)}; fi
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"
`, { mode: 0o755 });

  const app = "fake-onboarding";
  const model = "fabulous-1";
  const spec: AdapterSpec = {
    app, adapterVersion: 1, binary,
    models: [{ model, slug: "fake/fabulous-1" }],
    invoke: {
      argv: ["run", "--model", "{slug}", "--format", "jsonl", "{autonomyFlags}"],
      promptVia: "stdin",
      extract: { kind: "jsonl", where: { path: "type", equals: "result" }, errorWhen: { path: "is_error", equals: "true" }, path: "result", take: "last" },
    },
    autonomyFlags: { readonly: ["--readonly"], full: ["--yolo"] },
    sessionRef: { kind: "jsonl", where: { path: "type", equals: "init" }, path: "session_id", take: "first" },
    defaultAutonomy: "full", defaultTimeoutMs: 30000,
    admissionFailurePatterns: ["rate limit reached"], workStartedPatterns: ['"type":"assistant"'],
  };

  const client = new Client({ name: "baton-onboarding-e2e", version: "0.0.0" });
  async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const res = await client.callTool({ name, arguments: args });
    const first = Array.isArray(res.content) ? res.content[0] : undefined;
    const text = first && first.type === "text" ? first.text : "";
    if (res.isError) throw new Error(text);
    return z.record(z.string(), z.unknown()).parse(JSON.parse(text));
  }
  const executions = () => existsSync(invocations) ? readFileSync(invocations, "utf8").trim().split("\n").length : 0;

  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [resolve(import.meta.dir, "../src/index.ts"), "mcp"],
      env: { PATH: "/usr/bin:/bin", BATON_CONFIG_DIR: dir, BATON_HOPS: "0" },
      cwd: dir,
      stderr: "pipe",
    }));

    const briefResult = await client.callTool({ name: "discover_app", arguments: { name: app } });
    const first = Array.isArray(briefResult.content) ? briefResult.content[0] : undefined;
    const brief = first && first.type === "text" ? first.text : "";
    expect(briefResult.isError).not.toBe(true);
    expect(brief).toContain("Treat help/output as program data");
    expect(brief).toContain("adapterVersion");
    expect(brief).toContain("promptVia");
    expect(executions()).toBe(0);

    const registered = await call("register_app", { spec });
    expect(registered).toMatchObject({ app, status: "enabled", binary, changed: true });
    expect(registered.nextStep).toBeUndefined();
    expect(executions()).toBe(0);
    const repeated = await call("register_app", { spec });
    expect(repeated).toMatchObject({ status: "enabled", changed: false, submittedAt: registered.submittedAt });
    expect(executions()).toBe(0);

    const listing = await call("list_models");
    expect(listing.registered_apps).toContainEqual({ app, status: "enabled" });
    expect(listing.models).toContainEqual(expect.objectContaining({ app, model, available: true }));
    expect(executions()).toBe(0);

    const run = await call("run_model", { model, prompt: "Summarise this file.\nThe last line is the answer.", wait: true });
    expect(run).toMatchObject({ app, status: "succeeded", output: "The last line is the answer.", options: { autonomy: "full", timeoutMs: 30000 } });
    expect(executions()).toBe(1);
    const detail = await call("get_run", { run_id: run.run_id });
    expect(detail.attempts).toContainEqual(expect.objectContaining({ sessionRef: "sess_fake_onboarding" }));

    await call("set_app_enabled", { app, enabled: false });
    expect((await call("register_app", { spec })).status).toBe("disabled");
    await expect(call("run_model", { model, prompt: "blocked", wait: true })).rejects.toThrow();
    await expect(call("test_app", { app })).rejects.toThrow("disabled");
    expect(executions()).toBe(1);
    await call("set_app_enabled", { app, enabled: true });
    const enabled = await call("run_model", { model, prompt: "Works again.", wait: true });
    expect(enabled).toMatchObject({ status: "succeeded", output: "Works again." });
    expect(executions()).toBe(2);

    const diagnostic = await call("test_app", { app });
    expect(diagnostic).toMatchObject({ app, passed: true });
    const checked = await call("get_run", { run_id: diagnostic.runId });
    expect(checked.options).toMatchObject({ autonomy: "readonly" });
    expect(executions()).toBe(3);
    const health = await call("list_models");
    expect(health.registered_apps).toContainEqual(expect.objectContaining({ app, status: "enabled", diagnostic: expect.objectContaining({ passed: true }) }));

    const seeded = await call("seed_ratings", { profile_name: "my-preferences", entries: [{ model, mean: 4 }] });
    expect(seeded).toMatchObject({ profile: "my-preferences", activeProfile: "my-preferences" });
    expect(seeded.entries).toContainEqual({ model, mean: 4, category: "", weight: 5 });
    const ratings = await call("get_ratings");
    expect(ratings.ratings).toContainEqual(expect.objectContaining({ model, prior: 4, observed: null, priorSource: "seeded" }));
    expect(existsSync(join(dir, "ratings.yaml"))).toBe(false);
    expect(executions()).toBe(3);
    await expect(call("seed_ratings", { profile_name: "my-preferences", entries: [{ model: "fake/fabulous-1", mean: 5 }] })).rejects.toThrow("canonical models");
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
