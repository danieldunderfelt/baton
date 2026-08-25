import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serveHttp, type HttpDaemon } from "./http.ts";

/**
 * The HTTP daemon over an ephemeral port, talked to with the SDK's Streamable
 * HTTP client: same tools as stdio, same scope rules. In-process (the daemon is
 * a library call, unlike `baton mcp`), so BATON_CONFIG_DIR is set around it —
 * the temp scope is what keeps this off the developer's real state.
 */

let daemon: HttpDaemon;
let dir: string;
let previousScope: string | undefined;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "baton-http-"));
  previousScope = process.env.BATON_CONFIG_DIR;
  process.env.BATON_CONFIG_DIR = dir;
  // Port 0: never collide with a daemon the developer is actually running.
  daemon = serveHttp({ port: 0 });
});

afterAll(async () => {
  await daemon?.close();
  if (previousScope === undefined) delete process.env.BATON_CONFIG_DIR;
  else process.env.BATON_CONFIG_DIR = previousScope;
  rmSync(dir, { recursive: true, force: true });
});

async function connect(): Promise<Client> {
  const client = new Client({ name: "baton-http-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(daemon.url)));
  return client;
}

describe("serveHttp", () => {
  test("binds loopback on the requested port and serves the scope it inherited", () => {
    expect(daemon.port).toBeGreaterThan(0);
    expect(daemon.url).toStartWith("http://127.0.0.1:");
    expect(daemon.configDir).toBe(dir);
  });

  test("serves the same tool surface as stdio to an SDK HTTP client", async () => {
    const client = await connect();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "discover_app",
        "get_ratings",
        "get_run",
        "list_models",
        "register_app",
        "report_duel",
        "report_result",
        "resume_run",
        "run_duel",
        "run_model",
        "seed_ratings",
      ]);
    } finally {
      await client.close();
    }
  }, 30_000);

  test("tool calls reach the same broker state as the CLI's", async () => {
    const client = await connect();
    try {
      const res = await client.callTool({ name: "list_models", arguments: {} });
      const first = Array.isArray(res.content) ? res.content[0] : undefined;
      const payload = JSON.parse(first && first.type === "text" ? first.text : "{}") as {
        scope: { scoped: boolean; configDir: string };
        models: { model: string }[];
      };
      // One daemon per environment scope: the answer is that scope's, not a
      // per-connection sandbox.
      expect(payload.scope).toEqual({ scoped: true, configDir: dir });
      expect(payload.models.map((m) => m.model)).toContain("kimi-k3");
    } finally {
      await client.close();
    }
  }, 30_000);

  test("a cross-origin request is refused before it reaches the tools", async () => {
    const res = await fetch(daemon.url, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    // DNS rebinding is the one attack a loopback broker that spawns agent CLIs
    // with your subscriptions actually has to care about.
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
  });

  test("closing twice is safe", async () => {
    const second = serveHttp({ port: 0 });
    await second.close();
    await second.close();
    const reachable = await fetch(second.url).then(
      () => true,
      () => false,
    );
    expect(reachable).toBe(false);
  });
});
