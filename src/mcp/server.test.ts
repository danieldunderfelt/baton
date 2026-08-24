import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { openStore } from "../store/store.ts";

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

/**
 * `hops` seeds BATON_HOPS so the recursion guard's state is explicit, not
 * inherited; `reuseDir` reconnects to an existing scope (what makes startup
 * behaviour, not just per-call behaviour, testable).
 */
async function connect(
  hops = "0",
  overrides: Record<string, string> = {},
  reuseDir?: string,
): Promise<Session> {
  const dir = reuseDir ?? mkdtempSync(join(tmpdir(), "baton-mcp-"));
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
      // Only the session that created the scope disposes of it: a reconnect
      // must leave the scope standing for the next one.
      if (!reuseDir) rmSync(dir, { recursive: true, force: true });
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
  test("exposes exactly the phase-2 tool set with usable schemas", async () => {
    const { tools } = await session.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_ratings",
      "get_run",
      "list_models",
      "report_result",
      "run_model",
      "seed_ratings",
    ]);

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
    // Failover is observable now: one run can carry several attempts.
    expect(getRun.description).toContain("failover chain");

    const report = tools.find((t) => t.name === "report_result")!;
    expect((report.inputSchema.required as string[]).sort()).toEqual(["grade", "run_id"]);
    // The three things a grading agent gets wrong without being told — the last
    // one because the tool refuses those runs, so the text must not invite them.
    expect(report.description).toContain("AFTER");
    expect(report.description).toContain("REPLACES");
    expect(report.description).toContain("reliability");

    const seed = tools.find((t) => t.name === "seed_ratings")!;
    expect((seed.inputSchema.required as string[]).sort()).toEqual(["entries", "profile_name"]);
    // Propose/approve, and the cap that keeps a wrong seed from steering routing.
    expect(seed.description).toContain("approve");
    expect(seed.description).toContain("capped at 10");
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
    expect(apps.map((a) => a.app)).toEqual([...apps.map((a) => a.app)].sort());
    expect(apps.map((a) => a.app)).toContain("codex");
  });

  test("carries the phase-2 score fields without renaming the phase-1 ones", async () => {
    const payload = await callJson(session.client, "list_models");
    const models = payload.models as Record<string, unknown>[];
    const entry = models.find((m) => m.model === "kimi-k3")!;

    // Backwards compatible: everything phase 1 promised is still spelled the same.
    expect(Object.keys(entry)).toEqual(
      expect.arrayContaining(["model", "app", "slug", "available", "instance", "rating"]),
    );
    // Provenance stays separated in the payload, not merged into one number.
    expect(entry.rating).toBe("unrated");
    expect(entry.scores).toEqual({ observed: null, nEff: 0, prior: null, blended: null });
    expect(entry.maxAutonomy).toBe("full");
    // No pool is defined in a fresh scope, so there is nothing to spread across.
    expect(entry.pool).toBeUndefined();
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

// --- Eval surface: report_result / seed_ratings / get_ratings ---------------

/**
 * The scope's own database, opened from the test process. Real delegation needs
 * live CLIs, so the graded runs are inserted here directly: what is under test
 * is the tool layer — how a run_id resolves to evidence, what it commits, and
 * what it publishes — not the supervisor that would normally write these rows.
 */
function scopeDb(dir: string): Database {
  return openStore(join(dir, "state", "baton.db"));
}

interface FakeAttempt {
  target: string;
  status: string;
  /** Unfinished attempts are still in flight: nothing to grade. */
  finished?: boolean;
}

function insertRun(
  db: Database,
  runId: string,
  attempts: FakeAttempt[],
  run: { model?: string; category?: string | null; status?: string } = {},
): void {
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO runs (id, model, app, slug, instance, prompt, cwd, category, options, status,
                       policy_version, created_at, updated_at)
     VALUES (?, ?, 'kimi', 'kimi-code/k3', 'default', 'do a thing', '/tmp', ?, '{}', ?, 2, ?, ?)`,
  ).run(
    runId,
    run.model ?? "kimi-k3",
    run.category ?? null,
    run.status ?? "succeeded",
    now,
    now,
  );
  attempts.forEach((a, i) => {
    db.query(
      `INSERT INTO attempts (id, run_id, seq, target, status, output, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, 'answer', ?, ?)`,
    ).run(`${runId}_a${i + 1}`, runId, i + 1, a.target, a.status, now, a.finished === false ? null : now);
  });
}

interface GradeRow {
  grade: number;
  notes: string | null;
  category: string;
  target: string;
  model: string;
}

function gradeRow(db: Database, runId: string): GradeRow | null {
  return db
    .query<GradeRow, [string]>(
      "SELECT grade, notes, category, target, model FROM grades WHERE run_id = ?",
    )
    .get(runId);
}

function revisionOf(db: Database): number {
  const row = db
    .query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'ratings_revision'")
    .get();
  return Number.parseInt(row?.value ?? "0", 10);
}

function ratingsYaml(dir: string): string {
  return readFileSync(join(dir, "ratings.yaml"), "utf8");
}

const KIMI_TARGET = "kimi:default/kimi-code/k3@a1+full";

describe("report_result", () => {
  let evalSession: Session;
  let db: Database;

  beforeAll(async () => {
    evalSession = await connect();
    db = scopeDb(evalSession.dir);
  }, 30_000);

  afterAll(async () => {
    db?.close();
    await evalSession?.close();
  });

  test("grades a finished run, bumps the revision and republishes ratings.yaml", async () => {
    insertRun(db, "run_graded", [{ target: KIMI_TARGET, status: "succeeded" }], {
      category: "implementation",
    });
    const before = revisionOf(db);

    const res = await callJson(evalSession.client, "report_result", {
      run_id: "run_graded",
      grade: 4,
      notes: "did the job",
    });

    expect(res).toMatchObject({
      run_id: "run_graded",
      grade: 4,
      model: "kimi-k3",
      category: "implementation",
      target: KIMI_TARGET,
    });
    expect(res.revision as number).toBeGreaterThan(before);

    // The grade is the raw private record; the accumulator is the evidence.
    expect(gradeRow(db, "run_graded")).toEqual({
      grade: 4,
      notes: "did the job",
      category: "implementation",
      target: KIMI_TARGET,
      model: "kimi-k3",
    });
    expect(revisionOf(db)).toBe(res.revision as number);

    // The projection lands in the scope's config dir, stamped with the revision
    // it was rendered from — that stamp is what makes a stale write refusable.
    expect(ratingsYaml(evalSession.dir)).toContain(`# source_revision: ${res.revision}`);
    expect(ratingsYaml(evalSession.dir)).toContain("model: kimi-k3");
  });

  test("re-reporting replaces the grade instead of stacking a second one", async () => {
    const first = await callJson(evalSession.client, "report_result", {
      run_id: "run_graded",
      grade: 1,
    });
    const ratings = await callJson(evalSession.client, "get_ratings");
    const rows = ratings.ratings as { model: string; category: string; observed: number }[];
    const row = rows.find((r) => r.model === "kimi-k3" && r.category === "implementation")!;

    // 4 then 1 is 1, not the 2.5 an accumulated pair would give.
    expect(row.observed).toBeCloseTo(1, 6);
    expect(gradeRow(db, "run_graded")).toMatchObject({ grade: 1, notes: null });
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM grades").get()?.n).toBe(1);
    expect(ratingsYaml(evalSession.dir)).toContain(`# source_revision: ${first.revision}`);
  });

  test("evidence attaches to the attempt that answered, not the one that was refused", async () => {
    const failedOver = "kimi:personal-2/kimi-code/k3@a1+full";
    insertRun(
      db,
      "run_failover",
      [
        { target: KIMI_TARGET, status: "failed" },
        { target: failedOver, status: "succeeded" },
      ],
      { category: "review" },
    );

    const res = await callJson(evalSession.client, "report_result", {
      run_id: "run_failover",
      grade: 5,
    });

    expect(res.target).toBe(failedOver);
    expect(
      db
        .query<{ target: string }, []>("SELECT target FROM accumulator WHERE category = 'review'")
        .get()?.target,
    ).toBe(failedOver);
  });

  test("a run whose attempt has not finished has nothing to grade yet", async () => {
    insertRun(db, "run_live", [{ target: KIMI_TARGET, status: "running", finished: false }], {
      status: "running",
    });
    const { isError, text } = await call(evalSession.client, "report_result", {
      run_id: "run_live",
      grade: 3,
    });
    expect(isError).toBe(true);
    expect(text).toContain("run_live");
    expect(text).toContain("running");
    expect(gradeRow(db, "run_live")).toBeNull();
  });

  test("a run that produced no answer is reliability evidence, not a grade", async () => {
    insertRun(
      db,
      "run_dead",
      [
        { target: KIMI_TARGET, status: "failed" },
        { target: "kimi:personal-2/kimi-code/k3@a1+full", status: "timeout" },
      ],
      { status: "timeout", category: "implementation" },
    );
    const before = revisionOf(db);

    const { isError, text } = await call(evalSession.client, "report_result", {
      run_id: "run_dead",
      grade: 1,
    });

    // Grading the last *finished* attempt would have blamed a model for its
    // harness — and mid-failover, blamed the instance that refused the work.
    expect(isError).toBe(true);
    expect(text).toContain("run_dead");
    expect(text).toContain("reliability");
    expect(gradeRow(db, "run_dead")).toBeNull();
    expect(revisionOf(db)).toBe(before);
  });

  test("a still-running run is refused even once one attempt has succeeded", async () => {
    // The window between an attempt's commit and the run's own status flip: the
    // caller has not seen a settled run yet, so it cannot have used the answer.
    insertRun(db, "run_racing", [{ target: KIMI_TARGET, status: "succeeded" }], {
      status: "running",
    });
    const { isError, text } = await call(evalSession.client, "report_result", {
      run_id: "run_racing",
      grade: 5,
    });
    expect(isError).toBe(true);
    expect(text).toContain("still running");
    expect(gradeRow(db, "run_racing")).toBeNull();
  });

  test("an unknown handle names the scope it was looked for in", async () => {
    const { isError, text } = await call(evalSession.client, "report_result", {
      run_id: "run_elsewhere",
      grade: 3,
    });
    expect(isError).toBe(true);
    expect(text).toContain("run_elsewhere");
    expect(text).toContain(evalSession.dir);
  });

  test("an out-of-range grade is refused by the schema, before any commit", async () => {
    insertRun(db, "run_range", [{ target: KIMI_TARGET, status: "succeeded" }]);
    const before = revisionOf(db);
    const { isError } = await call(evalSession.client, "report_result", {
      run_id: "run_range",
      grade: 9,
    });
    expect(isError).toBe(true);
    expect(revisionOf(db)).toBe(before);
  });
});

describe("seed_ratings / get_ratings", () => {
  let seedSession: Session;
  let db: Database;

  beforeAll(async () => {
    seedSession = await connect();
    db = scopeDb(seedSession.dir);
  }, 30_000);

  afterAll(async () => {
    db?.close();
    await seedSession?.close();
  });

  test("an unseeded scope reports an empty, revision-zero state", async () => {
    const res = await callJson(seedSession.client, "get_ratings");
    expect(res.revision).toBe(0);
    expect(res.profile).toBeNull();
    expect(res.ratings).toEqual([]);
    expect(res.ratingsFile).toBe(join(seedSession.dir, "ratings.yaml"));
  });

  test("echoes the entries as committed, activates the profile and publishes", async () => {
    const res = await callJson(seedSession.client, "seed_ratings", {
      profile_name: "daniel",
      entries: [
        { model: "kimi-k3", mean: 4.5, weight: 50 },
        { model: "gpt-5.6-sol", category: "review", mean: 3 },
      ],
    });

    // Echo semantics: defaults and the cap are applied in the answer, so the
    // user approves what actually landed rather than what was proposed.
    expect(res.entries).toEqual([
      { model: "kimi-k3", category: "", mean: 4.5, weight: 10 },
      { model: "gpt-5.6-sol", category: "review", mean: 3, weight: 5 },
    ]);
    expect(res.profile).toBe("daniel");
    expect(res.activeProfile).toBe("daniel");
    expect(res.revision).toBe(revisionOf(db));
    expect(ratingsYaml(seedSession.dir)).toContain(`# source_revision: ${res.revision}`);
  });

  test("get_ratings reports prior and observed separately, in deterministic order", async () => {
    const res = await callJson(seedSession.client, "get_ratings");
    expect(res.profile).toBe("daniel");
    expect(res.profileWeight).toBe(1);

    const rows = res.ratings as {
      model: string;
      category: string;
      observed: number | null;
      prior: number | null;
      priorWeight: number;
      priorSource: string | null;
      blended: number | null;
    }[];
    expect(rows.map((r) => `${r.model}/${r.category}`)).toEqual([
      "gpt-5.6-sol/review",
      "kimi-k3/",
    ]);
    expect(rows[1]).toMatchObject({
      model: "kimi-k3",
      observed: null,
      prior: 4.5,
      priorSource: "seeded",
      blended: 4.5,
    });
    // The published weight is the prior's *decayed* weight, so a seed made
    // seconds ago reports its cap minus an unmeasurable sliver, not the cap.
    expect(rows[1]!.priorWeight).toBeCloseTo(10, 6);
  });

  test("an unknown model is refused with the known ones, and commits nothing", async () => {
    const before = revisionOf(db);
    const { isError, text } = await call(seedSession.client, "seed_ratings", {
      profile_name: "daniel",
      entries: [
        { model: "kimi-k3", mean: 2 },
        { model: "gpt-9-imaginary", mean: 5 },
      ],
    });

    expect(isError).toBe(true);
    expect(text).toContain("gpt-9-imaginary");
    expect(text).toContain("kimi-k3");
    expect(revisionOf(db)).toBe(before);
    // The valid entry in the same call must not have landed either.
    expect(
      db
        .query<{ mean: number }, []>("SELECT mean FROM priors WHERE model = 'kimi-k3'")
        .get()?.mean,
    ).toBe(4.5);
  });

  test("re-seeding a model replaces its prior in place", async () => {
    const res = await callJson(seedSession.client, "seed_ratings", {
      profile_name: "daniel",
      entries: [{ model: "kimi-k3", mean: 2 }],
    });
    expect(res.entries).toEqual([{ model: "kimi-k3", category: "", mean: 2, weight: 5 }]);
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM priors WHERE model = 'kimi-k3'").get()
        ?.n,
    ).toBe(1);
  });
});

describe("startup", () => {
  test("repairs a stale ratings.yaml when the server comes up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "baton-mcp-repair-"));
    try {
      const first = await connect("0", {}, dir);
      const seeded = await callJson(first.client, "seed_ratings", {
        profile_name: "daniel",
        entries: [{ model: "kimi-k3", mean: 4 }],
      });
      await first.close();

      // What a publisher that died mid-flight leaves behind: a projection of an
      // older state that no later write would ever be triggered to correct.
      writeFileSync(join(dir, "ratings.yaml"), "# source_revision: 0\nratings: []\n");
      expect(existsSync(join(dir, "ratings.yaml"))).toBe(true);

      const second = await connect("0", {}, dir);
      try {
        const text = ratingsYaml(dir);
        expect(text).toContain(`# source_revision: ${seeded.revision}`);
        expect(text).toContain("model: kimi-k3");
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 45_000);
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
