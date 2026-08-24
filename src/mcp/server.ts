import type { Database } from "bun:sqlite";

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import { getAdapter } from "../adapters/builtin/index.ts";
import { executeAdapter, killProcessGroup } from "../adapters/executor.ts";
import type { Autonomy } from "../adapters/types.ts";
import { ensurePaths, resolvePaths, type BatonPaths } from "../config/paths.ts";
import {
  DEFAULT_PRIOR_WEIGHT,
  activeProfile,
  recordGrade,
  seedPriors,
} from "../eval/evalStore.ts";
import { publishRatings, ratingsPath, repairProjection, snapshotRatings } from "../eval/publish.ts";
import { PRIOR_WEIGHT_CAP } from "../eval/types.ts";
import { detectApps, knownModels, listModels } from "../registry/registry.ts";
import { openStore } from "../store/store.ts";
import { createSupervisor, type AdapterExec, type Supervisor } from "../supervisor/supervisor.ts";
import type { RunRequest, RunView } from "../supervisor/types.ts";

/**
 * The stdio MCP server (PLAN.md §MCP surface). State never travels between
 * calls implicitly: `run_model` mints a `run_id` handle and `get_run` polls it,
 * which is what keeps this server stateless at its own layer even while the
 * SDK's session transport is not.
 *
 * Phase 2 adds the evaluation loop — `report_result` (consumer grades after
 * *using* the answer), `seed_ratings` (propose/approve onboarding seeds) and
 * `get_ratings`. Those tools own no rating logic: they resolve arguments to
 * what the eval store needs, commit, and republish the ratings.yaml projection.
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
  // "Startup repairs a stale projection" (PLAN.md §Publication protocol): a
  // publisher that died mid-flight, or a config dir restored from elsewhere,
  // leaves ratings.yaml disagreeing with SQLite. Never fatal — routing reads
  // SQLite, so a broken projection must not stop the server from serving.
  try {
    repairProjection(db, paths.configDir);
  } catch (err) {
    console.error(`baton: could not repair ${ratingsPath(paths.configDir)}: ${message(err)}`);
  }
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
        "scores keeps provenance visible instead of merging it: observed (your own graded runs, decayed, worth nEff observations), prior (the active profile's seeded or imported opinion), and blended — what selection ranks on. rating is 'unrated' until either exists; grade runs with report_result to make it move. " +
        "pool, where an app has one, is the per-instance quota view selection spreads across: headroom 1 = untouched, and coolingUntil marks an instance parked after an admission failure. maxAutonomy is this scope's user-owned ceiling for that app. " +
        "Order is deterministic (model, then app). Nothing is cached server-side — every call re-reads PATH — so ttlMs is only a hint for how long you may reuse this answer yourself; call again after installing an app.",
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
      inputSchema: z.object({
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
      }),
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
        "attempts is the failover chain: an instance that refuses admission (rate limit or auth, before the callee started work) hands the run to the next instance in its pool under the same run_id, so several attempts can appear and the last one is the answer. " +
        "This is the polling half of wait:false. Handles are scope-local: a run_id only resolves in the scope that minted it.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ run_id: z.string().min(1).describe("Handle returned by run_model.") }),
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

  server.registerTool(
    "report_result",
    {
      title: "Grade a delegated run",
      description:
        "Grade a finished run AFTER you have used its result — the consumer grades, not the producer, so report once the answer proved good or bad in practice, not the moment it arrives. " +
        "grade is 1 (unusable) to 5 (excellent), and it is about how useful the answer was to you, not the model's reputation and not how long it took. " +
        "Only a run that produced an answer can be graded: a failed, timed-out or cancelled run is an infrastructure outcome, not model quality, and Baton has already recorded it as reliability against the execution target — there is nothing for you to report on those, so grading them is refused. " +
        "Upsert, so it is safe on retry: re-reporting the same run_id REPLACES the earlier grade (the old evidence is subtracted, never stacked), which is also how you correct a grade you got wrong. " +
        "The evidence attaches to the execution target that actually answered (app + instance + model + autonomy of the succeeded attempt) and to the run's own category, and rolls up to the canonical model — see get_ratings.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: z.object({
        run_id: z.string().min(1).describe("Handle of the run you are grading."),
        grade: z
          .number()
          .min(1)
          .max(5)
          .describe("1 = unusable, 3 = acceptable, 5 = excellent. Fractions are allowed."),
        notes: z
          .string()
          .optional()
          .describe("Why, in one line. Private to this scope; never exported."),
      }),
    },
    ({ run_id, grade, notes }) => {
      const graded = gradedAttempt(db, run_id, paths.configDir);
      const revision = recordGrade(db, {
        runId: run_id,
        grade,
        ...(notes === undefined ? {} : { notes }),
        category: graded.category,
        target: graded.target,
        model: graded.model,
        runAt: graded.runAt,
      });
      publishQuietly(db, paths.configDir);
      return json({
        run_id,
        grade,
        model: graded.model,
        category: graded.category,
        target: graded.target,
        revision,
        ratingsFile: ratingsPath(paths.configDir),
      });
    },
  );

  server.registerTool(
    "seed_ratings",
    {
      title: "Seed rating priors from what the user already believes",
      description:
        "Record the user's own ranking of these models as a prior profile, so routing starts from their opinion instead of from nothing. " +
        "You propose, the user approves: ask first, then send what they agreed to — the normalized entries come back exactly as committed, so you can show them what landed. " +
        "category defaults to '' (any work); seed per-category entries when the user distinguishes them ('kimi-k3 is a 4 for implementation, a 2 for review'). Speed and cost are NOT quality — do not fold them into mean. " +
        `weight is in pseudo-observations, defaults to ${DEFAULT_PRIOR_WEIGHT} and is capped at ${PRIOR_WEIGHT_CAP}, so a wrong seed cannot steer routing for months; observed grades outweigh it as they accumulate. ` +
        "Only canonical model ids from list_models are accepted, and re-seeding a (profile, model, category) replaces that entry. The first seeded profile becomes the active one.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: z.object({
        profile_name: z
          .string()
          .min(1)
          .describe("Name for this set of opinions, e.g. 'daniel'. Re-seeding updates it in place."),
        entries: z
          .array(
            z.object({
              model: z.string().min(1).describe("Canonical model id from list_models."),
              category: z
                .string()
                .optional()
                .describe("Task kind this opinion is about. Omit for all work."),
              mean: z.number().min(1).max(5).describe("Believed grade, 1–5, quality only."),
              weight: z
                .number()
                .min(0)
                .optional()
                .describe(`How sure, in pseudo-observations. Capped at ${PRIOR_WEIGHT_CAP}.`),
            }),
          )
          .min(1)
          .describe("The proposed priors, as confirmed by the user."),
      }),
    },
    ({ profile_name, entries }) => {
      const known = knownModels();
      const unknown = entries.map((e) => e.model).filter((m) => !known.includes(m));
      if (unknown.length > 0) {
        throw new Error(
          `Unknown model(s) ${unknown.join(", ")}: priors attach to canonical models, not to routes or apps. Known models: ${known.join(", ")}.`,
        );
      }
      const seeded = seedPriors(db, profile_name, entries);
      publishQuietly(db, paths.configDir);
      return json({
        profile: profile_name,
        activeProfile: activeProfile(db),
        revision: seeded.revision,
        // The store's own answer, defaults and cap applied — this is the
        // confirmation the user approves against (PLAN.md §Seeded priors), so it
        // must not be a second derivation of the same rules.
        entries: seeded.entries,
        ratingsFile: ratingsPath(paths.configDir),
      });
    },
  );

  server.registerTool(
    "get_ratings",
    {
      title: "Current ratings in this scope",
      description:
        "What this scope currently believes about each model, per category, with provenance kept separate: observed (your graded runs, decayed, worth n_eff observations), prior (the active profile's seed or import, and its source), and blended — the number selection ranks on. " +
        "revision is monotonic and bumps on every grade or seed; ratings.yaml in this scope's config dir carries the same number as source_revision, and is a generated view only — Baton never reads it back. Order is deterministic (model, then category).",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => {
      const snapshot = snapshotRatings(db);
      return json({
        revision: snapshot.revision,
        profile: snapshot.profile,
        profileWeight: snapshot.profileWeight,
        ratings: snapshot.rows,
        ratingsFile: ratingsPath(paths.configDir),
      });
    },
  );

  return server;
}

interface GradedAttempt {
  model: string;
  category: string;
  /** Execution-target fingerprint of the attempt that produced the answer. */
  target: string;
  /** When the work happened — a late grade weighs from then, not from now. */
  runAt: string;
}

/** A run in one of these is still in flight; every other status is terminal. */
const IN_FLIGHT: ReadonlySet<string> = new Set(["queued", "running"]);

/**
 * Where a grade belongs. Grades are quality evidence about an *answer*, so they
 * only exist for a settled run whose attempt succeeded: an adapter, CLI or
 * timeout failure is reliability against the target (the supervisor records it
 * itself), and mid-failover the refused attempt did no work to judge. Grading
 * either would blame a model for its harness. Same rule as `baton grade`.
 */
function gradedAttempt(db: Database, runId: string, configDir: string): GradedAttempt {
  const run = db
    .query<{ model: string; category: string | null; status: string }, [string]>(
      "SELECT model, category, status FROM runs WHERE id = ?",
    )
    .get(runId);
  if (!run) {
    throw new Error(
      `No run '${runId}' in this scope (${configDir}). Grades attach to runs this scope launched; check the run_id, or list recent runs with 'baton runs'.`,
    );
  }
  if (IN_FLIGHT.has(run.status)) {
    throw new Error(
      `Run '${runId}' is still ${run.status}, so there is no result to grade yet. Poll get_run, use the answer, then report.`,
    );
  }
  const attempt = db
    .query<{ target: string; started_at: string | null; finished_at: string | null }, [string]>(
      `SELECT target, started_at, finished_at FROM attempts
       WHERE run_id = ? AND status = 'succeeded' ORDER BY seq DESC LIMIT 1`,
    )
    .get(runId);
  if (!attempt) {
    throw new Error(
      `Run '${runId}' ended as ${run.status} and produced no answer, so there is nothing to grade: grades are about answer quality. Baton already recorded that failure as reliability against the execution target, so there is nothing for you to report — delegate again if you still need the work done.`,
    );
  }
  return {
    model: run.model,
    category: run.category ?? "",
    target: attempt.target,
    runAt: attempt.finished_at ?? attempt.started_at ?? new Date().toISOString(),
  };
}

/**
 * ratings.yaml is a derived projection: a failed publish must never fail the
 * commit it would have shown. The state is already in SQLite, and the next
 * publish — or the startup repair — catches the file up.
 */
function publishQuietly(db: Database, configDir: string): void {
  try {
    publishRatings(db, configDir);
  } catch (err) {
    console.error(`baton: could not publish ${ratingsPath(configDir)}: ${message(err)}`);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
