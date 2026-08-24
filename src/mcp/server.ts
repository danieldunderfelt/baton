import type { Database } from "bun:sqlite";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { getAdapter } from "../adapters/builtin/index.ts";
import { executeAdapter, killProcessGroup } from "../adapters/executor.ts";
import type { Autonomy } from "../adapters/types.ts";
import { ensurePaths, resolvePaths, type BatonPaths } from "../config/paths.ts";
import { detectApps, listModels } from "../registry/registry.ts";
import { openStore } from "../store/store.ts";
import { createSupervisor, type AdapterExec, type Supervisor } from "../supervisor/supervisor.ts";
import type { RunRequest, RunView } from "../supervisor/types.ts";

/**
 * The stdio MCP server (PLAN.md §MCP surface, phase-1 set). State never travels
 * between calls implicitly: `run_model` mints a `run_id` handle and `get_run`
 * polls it, which is what keeps this server stateless at its own layer even
 * while the SDK's session transport is not.
 */

const NAME = "baton";
const VERSION = "0.1.0";

/** Ceiling on how long one `wait: true` call may block, whatever the adapter allows. */
const MAX_WAIT_MS = 600_000;
/** Slack so the wait outlives the callee's own timeout and reports the timeout status. */
const WAIT_MARGIN_MS = 5_000;
const FALLBACK_TIMEOUT_MS = 300_000;
/**
 * Caller-side cache hint only — Baton caches nothing, every call re-reads PATH.
 * It says how long the answer is worth reusing, not how stale it may be served.
 */
const LIST_MODELS_TTL_MS = 60_000;
/**
 * Shutdown kill budget. Hosts give a stdio server a few seconds after EOF or
 * SIGTERM before SIGKILLing it, so the escalation has to fit inside that.
 */
const SHUTDOWN_KILL = { graceMs: 1_500, deadlineMs: 4_000 };

/** Object form so the enum stays exhaustive against Autonomy at compile time. */
const AUTONOMY = {
  readonly: "readonly",
  edits: "edits",
  full: "full",
} as const satisfies Record<Autonomy, Autonomy>;

export async function serveMcp(): Promise<void> {
  const paths = ensurePaths(resolvePaths(process.env));
  const db = openStore(paths.dbPath);
  const livePids = new Set<number>();
  const supervisor = createSupervisor({
    db,
    env: process.env,
    hostCwd: process.cwd(),
    exec: trackingExec(livePids),
  });
  const server = buildServer(paths, db, supervisor);

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    // Mark the runs cancelled, then confirm the callees are actually gone:
    // supervisor.cancelRun only sends SIGTERM and schedules an unref'd SIGKILL,
    // which a process on its way out never fires (sol#1). Exiting here without
    // waiting is how "shutdown" leaves agent CLIs running unsupervised.
    supervisor.shutdown();
    await Promise.all([...livePids].map((pid) => killProcessGroup(pid, SHUTDOWN_KILL)));
    try {
      await server.close();
    } catch {
      // The transport is going away regardless; the DB still has to be closed.
    }
    try {
      db.close();
    } catch {
      // Nothing left to salvage — every run outcome is already committed.
    }
    process.exit(0);
  };

  // Host disconnect (stdin EOF) is the normal exit path; signals are the rest.
  server.server.onclose = () => void shutdown();
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await server.connect(new StdioServerTransport());
  // stdin keeps the loop alive; shutdown() is the only exit.
}

/** The executor, with each spawned process group recorded so shutdown can end it. */
function trackingExec(livePids: Set<number>): AdapterExec {
  return (req, hooks) => {
    let pid: number | undefined;
    return executeAdapter({
      ...req,
      onSpawn: (spawned) => {
        pid = spawned;
        livePids.add(spawned);
        hooks?.onSpawn?.(spawned);
      },
    }).finally(() => {
      if (pid !== undefined) livePids.delete(pid);
    });
  };
}

function buildServer(paths: BatonPaths, db: Database, supervisor: Supervisor): McpServer {
  const server = new McpServer({ name: NAME, version: VERSION }, { capabilities: { tools: {} } });

  server.registerTool(
    "list_models",
    {
      title: "List delegatable models",
      description:
        "Models this Baton scope can delegate to, with the app that would run each one and whether that app's binary is on PATH right now (unavailable entries are listed so you can see what is missing). " +
        "A model that cannot be used right now carries degradedReason (its app's binary is not on PATH, or this scope's authority ceiling is one the adapter cannot express). " +
        "Also reports the scope: Baton's world is partitioned by BATON_CONFIG_DIR, so a scope only knows the instances, settings and evidence its own config dir defines. " +
        "Order is deterministic (model, then app). Nothing is cached server-side — every call re-reads PATH — so ttlMs is only a hint for how long you may reuse this answer yourself; call again after installing an app. Ratings are 'unrated' in phase 1.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      json({
        ttlMs: LIST_MODELS_TTL_MS,
        scope: { scoped: paths.scoped, configDir: paths.configDir },
        apps: detectApps({ probeVersion: false }).map((a) => ({
          app: a.app,
          available: a.binaryPath !== null,
          binaryPath: a.binaryPath,
        })),
        models: listModels(db),
      }),
  );

  server.registerTool(
    "run_model",
    {
      title: "Delegate a task to another model",
      description:
        "Hand a prompt to a model running in another agent CLI on this machine, using that app's own subscription. Always returns a run_id handle. " +
        "wait (default true) blocks until the run finishes and inlines output; if the budget runs out you get status 'running' and poll get_run with the run_id. " +
        "wait:false returns as soon as the run is launched — that plus get_run is the polling path for long tasks, and the polite way to keep several delegations in flight without holding a call open. " +
        "idempotency_key is retry-safe and payload-bound: the same key with the same request returns the existing run (deduplicated:true) instead of launching a second one, so a transport retry cannot double-spend quota; the same key with a changed prompt, cwd or options is an error, so use a NEW key for anything you actually changed. " +
        "cwd defaults to this host's working directory; pointing the delegated agent at another checkout is allowed and deliberate — note that concurrent delegates mutating the same checkout can conflict. " +
        "options.autonomy narrows what the callee may do (readonly | edits | full); it can only narrow the user's per-app ceiling, never raise it. options.timeoutMs bounds the callee. " +
        "Errors (unknown model, no installed app for it, delegation-depth refusal) come back as tool errors, not as a failed run. " +
        "So does hitting this scope's concurrency cap ('max_concurrent'): that one means too many attempts are already running, so let one finish instead of retrying in a loop — launch with wait:false and poll get_run rather than holding calls open.",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      inputSchema: {
        model: z
          .string()
          .min(1)
          .describe("Canonical model id from list_models, e.g. 'kimi-k3' or 'gpt-5.6-sol'."),
        prompt: z
          .string()
          .min(1)
          .describe("The full task for the callee. It gets no other context from you."),
        cwd: z
          .string()
          .optional()
          .describe("Working directory for the callee. Defaults to this host's cwd."),
        instance: z
          .string()
          .optional()
          .describe(
            "Named instance (env overlay) of the serving app. Omit for the inherited environment.",
          ),
        wait: z
          .boolean()
          .default(true)
          .describe("Block until the run settles (bounded). false returns the run_id immediately."),
        category: z
          .string()
          .optional()
          .describe("Task kind, e.g. 'implementation' or 'review'. Recorded for rating evidence."),
        options: z
          .object({
            autonomy: z
              .enum(AUTONOMY)
              .optional()
              .describe("Requested authority. Clamped down to the scope's ceiling for that app."),
            timeoutMs: z
              .int()
              .positive()
              .optional()
              .describe("Kill the callee after this long. Defaults to the adapter's own timeout."),
          })
          .optional(),
        idempotency_key: z
          .string()
          .optional()
          .describe("Retry-safe key: the same key returns the existing run instead of relaunching."),
      },
    },
    async (args) => {
      const req: RunRequest = {
        model: args.model,
        prompt: args.prompt,
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        ...(args.instance === undefined ? {} : { instance: args.instance }),
        ...(args.category === undefined ? {} : { category: args.category }),
        ...(args.options === undefined ? {} : { options: args.options }),
        ...(args.idempotency_key === undefined ? {} : { idempotencyKey: args.idempotency_key }),
      };

      const { view, settled } = await supervisor.startRun(req);
      settled.catch(() => {}); // outcomes are recorded in SQLite; nothing to handle here
      if (!args.wait) return json(summary(view));

      const settledView = await supervisor.waitForRun(view.runId, waitBudget(view, req));
      return json(summary({ ...settledView, deduplicated: view.deduplicated }));
    },
  );

  server.registerTool(
    "get_run",
    {
      title: "Poll a delegated run",
      description:
        "Full state of a run started by run_model: status (queued | running | succeeded | failed | timeout | cancelled | orphaned), the extracted output once it succeeded, the error otherwise, and the per-attempt detail. " +
        "This is the polling half of wait:false. Handles are scope-local: a run_id only resolves in the scope that minted it.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: { run_id: z.string().min(1).describe("Handle returned by run_model.") },
    },
    ({ run_id }) => {
      const view = supervisor.getRun(run_id);
      if (!view) {
        throw new Error(
          `No run '${run_id}' in this scope (${paths.configDir}). Check the run_id, or list recent runs with 'baton runs'.`,
        );
      }
      return json(view);
    },
  );

  return server;
}

/** Never block longer than the callee can run, and never longer than the hard ceiling. */
function waitBudget(view: RunView, req: RunRequest): number {
  const adapterDefault = getAdapter(view.app)?.defaultTimeoutMs ?? FALLBACK_TIMEOUT_MS;
  return Math.min(req.options?.timeoutMs ?? adapterDefault, MAX_WAIT_MS) + WAIT_MARGIN_MS;
}

function summary(view: RunView): Record<string, unknown> {
  return {
    run_id: view.runId,
    status: view.status,
    model: view.model,
    app: view.app,
    instance: view.instance,
    ...(view.deduplicated ? { deduplicated: true } : {}),
    ...(view.output === undefined ? {} : { output: view.output }),
    ...(view.error === undefined ? {} : { error: view.error }),
  };
}

function json(payload: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}
