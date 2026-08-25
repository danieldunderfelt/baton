import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
} from "@modelcontextprotocol/server";

import { createMcpRuntime } from "./server.ts";

/**
 * `baton serve --http`: the same MCP server as `baton mcp`, over Streamable
 * HTTP (PLAN.md §Architecture). One daemon per environment scope, because a
 * daemon inherits exactly one environment — its callees run with whatever
 * identity the shell that started it supplied, and its evidence lands in that
 * scope's BATON_CONFIG_DIR. Two scopes need two daemons on two ports.
 *
 * The SDK v2 serves one server instance per HTTP exchange (the stateless 2026
 * core), so the handler is given a factory over one shared runtime: the tool
 * definitions are re-minted per request, the store and supervisor are not.
 *
 * Loopback only, plus Host/Origin validation in front of the handler: the SDK
 * entry is deliberately validation-free, and a broker that spawns agent CLIs
 * with the user's subscriptions is exactly what DNS rebinding would want.
 *
 * No caller authentication beyond that — the same threat model as stdio (any
 * local process could equally spawn `baton mcp` itself). Be aware of what the
 * daemon changes anyway: it turns that transient capability into a STANDING
 * loopback endpoint that any local process can drive at full autonomy on the
 * user's subscriptions for as long as it runs.
 */

/** Default daemon port. Arbitrary, unassigned, and stable across restarts. */
export const DEFAULT_HTTP_PORT = 7317;
/** Grace for in-flight handlers between stop-accepting and forced teardown. */
const SHUTDOWN_DRAIN_MS = 10_000;

export interface HttpDaemon {
  /** Endpoint to register with a host, e.g. http://127.0.0.1:7317/. */
  url: string;
  port: number;
  /** The scope this daemon serves — its BATON_CONFIG_DIR. */
  configDir: string;
  /** Stops listening, ends live callees, closes the store. Idempotent. */
  close(): Promise<void>;
}

export interface HttpOptions {
  /** 0 picks an ephemeral port; read the real one back from the daemon. */
  port?: number;
  /** Loopback by default. Anything else exposes your subscriptions to a LAN. */
  hostname?: string;
}

export function serveHttp(opts: HttpOptions = {}): HttpDaemon {
  const runtime = createMcpRuntime();
  const handler = createMcpHandler(() => runtime.createServer(), {
    // Out-of-band transport errors: reporting only, never a reason to die.
    onerror: (err) => console.error(`baton: http transport error: ${err.message}`),
  });

  const server = Bun.serve({
    port: opts.port ?? DEFAULT_HTTP_PORT,
    hostname: opts.hostname ?? "127.0.0.1",
    fetch: async (request) =>
      hostHeaderValidationResponse(request, localhostAllowedHostnames()) ??
      originValidationResponse(request, localhostAllowedOrigins()) ??
      (await handler.fetch(request)),
  });

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => (closing ??= shutdown());
  // A daemon outlives its callees only if it takes them with it: without this,
  // Ctrl-C leaves delegated agent CLIs running unsupervised.
  const onSignal = (): void => void close().then(() => process.exit(0));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  async function shutdown(): Promise<void> {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    // Stop accepting, then DRAIN before tearing down: an in-flight handler
    // (a `run_model` with wait inside waitForRun, say) that outlives a forced
    // stop would hit the closed database in dispose. Bounded — a handler that
    // will not finish inside the grace window gets cut off after all.
    const drained = server.stop(false);
    await Promise.race([drained, Bun.sleep(SHUTDOWN_DRAIN_MS)]);
    await server.stop(true);
    await runtime.dispose(() => handler.close());
  }

  const daemon: HttpDaemon = {
    url: server.url.href,
    port: Number(server.url.port),
    configDir: runtime.paths.configDir,
    close,
  };
  // The endpoint is the one thing a caller cannot derive (an ephemeral port is
  // only knowable from here). stdout stays clean; unlike `baton mcp`, nothing
  // here is a protocol stream.
  console.error(`baton: MCP over HTTP at ${daemon.url} (scope ${daemon.configDir})`);
  return daemon;
}
