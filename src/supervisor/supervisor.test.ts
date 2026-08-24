import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { executeAdapter } from "../adapters/executor.ts";
import type { AdapterSpec } from "../adapters/types.ts";
import type { Target } from "../registry/registry.ts";
import { newId, nowIso, openStore } from "../store/store.ts";
import {
  HOPS_ENV,
  SETTING_MAX_CONCURRENT,
  SETTING_MAX_HOPS,
  type RunStatus,
} from "./types.ts";
import { Supervisor, type SupervisorInit, type TargetResolver } from "./supervisor.ts";

/**
 * No real agent CLI is ever invoked here: the injectable resolver hands the
 * supervisor a fake AdapterSpec whose binary is this Bun executable, running
 * either the shared fake-cli fixture or a one-line script.
 */
const BUN = Bun.which("bun") ?? process.execPath;
const FIXTURE = join(import.meta.dir, "..", "adapters", "fixtures", "fake-cli.ts");

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function newDb(): Database {
  const dir = `/tmp/baton-supervisor-${crypto.randomUUID()}`;
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return openStore(join(dir, "baton.db"));
}

function fakeSpec(argv: string[], over: Partial<AdapterSpec> = {}): AdapterSpec {
  return {
    app: "fake",
    adapterVersion: 1,
    binary: BUN,
    models: [{ model: "fake-model", slug: "fake/slug" }],
    invoke: { argv, promptVia: "stdin", extract: { kind: "text" } },
    autonomyFlags: { readonly: [], edits: [], full: [] },
    defaultAutonomy: "full",
    defaultTimeoutMs: 10_000,
    admissionFailurePatterns: [],
    ...over,
  };
}

function target(spec: AdapterSpec, instance = "default"): Target {
  return {
    spec,
    slug: "fake/slug",
    instance,
    binaryPath: spec.binary,
    targetFingerprint: `${spec.app}:${instance}/fake/slug@a${spec.adapterVersion}`,
  };
}

function resolverFor(t: Target): TargetResolver {
  return { resolve: () => t };
}

/** A callee that runs `code` in a child Bun and prints whatever it prints. */
function evalTarget(code: string, instance = "default"): Target {
  return target(fakeSpec(["-e", code]), instance);
}

function supervisorFor(t: Target, init: Partial<SupervisorInit> & { db: Database }): Supervisor {
  return new Supervisor({
    env: { ...process.env },
    hostCwd: import.meta.dir,
    resolver: resolverFor(t),
    pollMs: 25,
    ...init,
  });
}

interface AttemptRow {
  id: string;
  seq: number;
  target: string;
  status: RunStatus;
  pid: number | null;
  exit_code: number | null;
  output: string | null;
  raw_tail: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

function attempts(db: Database, runId: string): AttemptRow[] {
  return db.query<AttemptRow, [string]>("SELECT * FROM attempts WHERE run_id = ? ORDER BY seq").all(runId);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function isDead(pid: number, withinMs = 6_000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
}

describe("startRun", () => {
  test("records a successful run end-to-end in SQLite", async () => {
    const db = newDb();
    const sup = supervisorFor(evalTarget("process.stdout.write('  done from callee \\n')"), { db });

    const { view, settled } = await sup.startRun({ model: "fake-model", prompt: "hi", category: "impl" });
    expect(view.status).toBe("running");
    expect(view.attempts).toHaveLength(1);
    expect(view.attempts[0]?.target).toBe("fake:default/fake/slug@a1+full");
    await settled;

    const final = sup.getRun(view.runId)!;
    expect(final.status).toBe("succeeded");
    expect(final.output).toBe("done from callee");
    expect(final.error).toBeUndefined();
    expect(final.model).toBe("fake-model");
    expect(final.app).toBe("fake");
    expect(final.instance).toBe("default");

    const row = attempts(db, view.runId)[0]!;
    expect(row.status).toBe("succeeded");
    expect(row.exit_code).toBe(0);
    expect(row.output).toBe("done from callee");
    expect(row.raw_tail).toContain("done from callee");
    expect(row.started_at).not.toBeNull();
    expect(row.finished_at).not.toBeNull();

    const run = db
      .query<{ category: string; options: string; policy_version: number }, [string]>(
        "SELECT category, options, policy_version FROM runs WHERE id = ?",
      )
      .get(view.runId)!;
    expect(run.category).toBe("impl");
    expect(JSON.parse(run.options)).toMatchObject({ autonomy: "full" });
    expect(run.policy_version).toBe(1);
  }, 20_000);

  test("a nonzero exit becomes a failed run carrying the error", async () => {
    const db = newDb();
    const sup = supervisorFor(evalTarget("process.stderr.write('boom\\n');process.exit(3)"), { db });

    const { view, settled } = await sup.startRun({ model: "fake-model", prompt: "hi" });
    await settled;

    const final = sup.getRun(view.runId)!;
    expect(final.status).toBe("failed");
    expect(final.error).toContain("exited with code 3");
    expect(attempts(db, view.runId)[0]?.exit_code).toBe(3);
  }, 20_000);

  test("the resolved autonomy is clamped by the app's ceiling and lands in the fingerprint", async () => {
    const db = newDb();
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("max_autonomy:fake", "readonly");
    const sup = supervisorFor(evalTarget("process.stdout.write('ok')"), { db });

    const { view, settled } = await sup.startRun({
      model: "fake-model",
      prompt: "hi",
      options: { autonomy: "full" },
    });
    await settled;
    expect(sup.getRun(view.runId)!.attempts[0]!.target).toBe("fake:default/fake/slug@a1+readonly");
  }, 20_000);
});

describe("idempotency", () => {
  test("the same key returns the existing run without re-executing", async () => {
    const db = newDb();
    let calls = 0;
    const t = evalTarget("process.stdout.write('once')");
    const sup = supervisorFor(t, {
      db,
      exec: (req) => {
        calls++;
        return executeAdapter(req);
      },
    });

    const first = await sup.startRun({ model: "fake-model", prompt: "hi", idempotencyKey: "k-1" });
    await first.settled;
    const second = await sup.startRun({ model: "fake-model", prompt: "hi", idempotencyKey: "k-1" });
    await second.settled;

    expect(second.view.runId).toBe(first.view.runId);
    expect(second.view.deduplicated).toBe(true);
    expect(first.view.deduplicated).toBeUndefined();
    expect(second.view.status).toBe("succeeded");
    expect(calls).toBe(1);
    expect(attempts(db, first.view.runId)).toHaveLength(1);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n).toBe(1);
  }, 20_000);

  test("different keys launch different runs", async () => {
    const db = newDb();
    const sup = supervisorFor(evalTarget("process.stdout.write('ok')"), { db });
    const a = await sup.startRun({ model: "fake-model", prompt: "hi", idempotencyKey: "k-a" });
    const b = await sup.startRun({ model: "fake-model", prompt: "hi", idempotencyKey: "k-b" });
    await Promise.all([a.settled, b.settled]);
    expect(b.view.runId).not.toBe(a.view.runId);
  }, 20_000);

  test("the same key with a different payload is refused, naming the original run", async () => {
    const db = newDb();
    const sup = supervisorFor(evalTarget("process.stdout.write('ok')"), { db });
    const first = await sup.startRun({
      model: "fake-model",
      prompt: "summarise the readme",
      idempotencyKey: "k-1",
    });
    await first.settled;

    await expect(
      sup.startRun({ model: "fake-model", prompt: "delete the readme", idempotencyKey: "k-1" }),
    ).rejects.toThrow(new RegExp(`k-1.*${first.view.runId}.*different payload`, "s"));
    // Nothing was launched, and the original run is untouched.
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n).toBe(1);
    expect(sup.getRun(first.view.runId)!.status).toBe("succeeded");
  }, 20_000);

  test("payload binding covers cwd, instance, category and options too", async () => {
    const db = newDb();
    const sup = supervisorFor(evalTarget("process.stdout.write('ok')"), { db });
    const base = { model: "fake-model", prompt: "hi", idempotencyKey: "k-2" } as const;
    const first = await sup.startRun({ ...base, category: "review" });
    await first.settled;

    await expect(sup.startRun({ ...base, category: "implementation" })).rejects.toThrow(
      /different payload/,
    );
    await expect(sup.startRun({ ...base, category: "review", cwd: "/tmp" })).rejects.toThrow(
      /different payload/,
    );
    await expect(
      sup.startRun({ ...base, category: "review", options: { timeoutMs: 5_000 } }),
    ).rejects.toThrow(/different payload/);
    // Same payload, options spelled with the same values: still a retry.
    const retry = await sup.startRun({ ...base, category: "review" });
    expect(retry.view.deduplicated).toBe(true);
  }, 20_000);

  test("a run carried over from schema v1 (payload_hash NULL) still dedups on its key", async () => {
    const db = newDb();
    const sup = supervisorFor(evalTarget("process.stdout.write('ok')"), { db });
    const first = await sup.startRun({ model: "fake-model", prompt: "hi", idempotencyKey: "k-v1" });
    await first.settled;
    // What migration v2 leaves behind: rows minted before the column existed.
    db.query("UPDATE runs SET payload_hash = NULL WHERE id = ?").run(first.view.runId);

    const retry = await sup.startRun({ model: "fake-model", prompt: "hi", idempotencyKey: "k-v1" });
    expect(retry.view.runId).toBe(first.view.runId);
    expect(retry.view.deduplicated).toBe(true);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n).toBe(1);
  }, 20_000);

  test("an empty idempotency key is refused rather than silently ignored", async () => {
    const db = newDb();
    const sup = supervisorFor(evalTarget("process.stdout.write('ok')"), { db });
    await expect(
      sup.startRun({ model: "fake-model", prompt: "hi", idempotencyKey: "" }),
    ).rejects.toThrow(/idempotency_key must be non-empty/);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n).toBe(0);
  });
});

describe("concurrency cap", () => {
  test("refuses a run once the scope's cap is reached, and admits again after", async () => {
    const db = newDb();
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(SETTING_MAX_CONCURRENT, "1");
    const sup = supervisorFor(evalTarget("setTimeout(() => process.stdout.write('slow'), 800)"), {
      db,
    });

    const first = await sup.startRun({ model: "fake-model", prompt: "one" });
    await expect(sup.startRun({ model: "fake-model", prompt: "two" })).rejects.toThrow(
      /concurrency cap.*max_concurrent.*is 1/s,
    );
    // The refused run was never recorded: no corpse, no quota spent.
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n).toBe(1);

    await first.settled;
    const second = await sup.startRun({ model: "fake-model", prompt: "two" });
    await second.settled;
    expect(sup.getRun(second.view.runId)!.status).toBe("succeeded");
  }, 30_000);

  test("the default cap admits several concurrent runs", async () => {
    const db = newDb();
    const sup = supervisorFor(evalTarget("setTimeout(() => process.stdout.write('slow'), 500)"), {
      db,
    });
    const runs = await Promise.all(
      [1, 2, 3, 4].map((n) => sup.startRun({ model: "fake-model", prompt: `p${n}` })),
    );
    await Promise.all(runs.map((r) => r.settled));
    expect(runs.every((r) => sup.getRun(r.view.runId)!.status === "succeeded")).toBe(true);
  }, 30_000);
});

describe("hop guard", () => {
  test("refuses at the depth limit, naming the depth and the setting", async () => {
    const db = newDb();
    const sup = supervisorFor(evalTarget("process.stdout.write('ok')"), {
      db,
      env: { ...process.env, [HOPS_ENV]: "2" },
    });

    await expect(sup.startRun({ model: "fake-model", prompt: "hi" })).rejects.toThrow(
      /already 2 delegation hop\(s\) deep.*max_hops' setting is 2/s,
    );
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n).toBe(0);
  });

  test("a raised max_hops setting lets the same depth through", async () => {
    const db = newDb();
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(SETTING_MAX_HOPS, "3");
    const sup = supervisorFor(evalTarget("process.stdout.write('ok')"), {
      db,
      env: { ...process.env, [HOPS_ENV]: "2" },
    });
    const { view, settled } = await sup.startRun({ model: "fake-model", prompt: "hi" });
    await settled;
    expect(sup.getRun(view.runId)!.status).toBe("succeeded");
  }, 20_000);
});

describe("callee environment", () => {
  test("inherits the environment, applies the instance overlay, increments BATON_HOPS", async () => {
    const db = newDb();
    db.query("INSERT INTO instances (app, name, env, created_at) VALUES (?, ?, ?, ?)").run(
      "fake",
      "acct2",
      JSON.stringify({ FAKE_OVERLAY: "on", BATON_INHERITED: "overridden" }),
      nowIso(),
    );
    const code =
      "process.stdout.write(JSON.stringify({hops:process.env.BATON_HOPS,overlay:process.env.FAKE_OVERLAY,inherited:process.env.BATON_INHERITED,passthrough:process.env.BATON_PASSTHROUGH}))";
    const sup = supervisorFor(evalTarget(code, "acct2"), {
      db,
      env: {
        ...process.env,
        [HOPS_ENV]: "1",
        BATON_INHERITED: "from-host",
        BATON_PASSTHROUGH: "kept",
      },
    });

    const { view, settled } = await sup.startRun({ model: "fake-model", prompt: "hi", instance: "acct2" });
    await settled;
    const final = sup.getRun(view.runId)!;
    expect(final.status).toBe("succeeded");
    expect(JSON.parse(final.output!)).toEqual({
      hops: "2",
      overlay: "on",
      inherited: "overridden",
      passthrough: "kept",
    });
    expect(final.instance).toBe("acct2");
  }, 20_000);

  test("the default instance applies no overlay", async () => {
    const db = newDb();
    db.query("INSERT INTO instances (app, name, env, created_at) VALUES (?, ?, ?, ?)").run(
      "fake",
      "acct2",
      JSON.stringify({ FAKE_OVERLAY: "on" }),
      nowIso(),
    );
    const sup = supervisorFor(
      evalTarget("process.stdout.write(JSON.stringify({overlay:process.env.FAKE_OVERLAY ?? null}))"),
      { db },
    );
    const { view, settled } = await sup.startRun({ model: "fake-model", prompt: "hi" });
    await settled;
    expect(JSON.parse(sup.getRun(view.runId)!.output!)).toEqual({ overlay: null });
  }, 20_000);
});

describe("timeout", () => {
  test("times out the run and kills the whole process group", async () => {
    const db = newDb();
    const sup = supervisorFor(target(fakeSpec([FIXTURE])), {
      db,
      env: { ...process.env, BATON_FAKE_MODE: "grandchild", BATON_FAKE_SLEEP_MS: "30000" },
    });

    const { view, settled } = await sup.startRun({
      model: "fake-model",
      prompt: "hi",
      options: { timeoutMs: 600 },
    });
    await settled;

    const final = sup.getRun(view.runId)!;
    expect(final.status).toBe("timeout");
    expect(final.error).toContain("timed out after 600ms");

    const row = attempts(db, view.runId)[0]!;
    expect(row.status).toBe("timeout");
    const line = (row.raw_tail ?? "").split("\n").find((l) => l.includes("grandchildPid"));
    const { grandchildPid } = JSON.parse(line ?? "{}") as { grandchildPid: number };
    expect(typeof grandchildPid).toBe("number");
    expect(await isDead(grandchildPid)).toBe(true);
  }, 30_000);
});

describe("cancelRun", () => {
  test("kills the live process group and marks the run cancelled", async () => {
    const db = newDb();
    // The real executor, so this covers the pid the executor actually reports.
    const sup = supervisorFor(evalTarget("setTimeout(() => {}, 60_000)"), { db });

    const { view, settled } = await sup.startRun({ model: "fake-model", prompt: "hi" });
    // The pid is recorded from onSpawn as soon as the child exists.
    let pid: number | null = null;
    for (let i = 0; i < 100 && pid === null; i++) {
      pid = attempts(db, view.runId)[0]?.pid ?? null;
      if (pid === null) await sleep(20);
    }
    expect(pid).not.toBeNull();

    sup.cancelRun(view.runId);
    expect(sup.getRun(view.runId)!.status).toBe("cancelled");

    await settled;
    expect(await isDead(pid!)).toBe(true);
    // The settling attempt must not overwrite the cancellation with 'failed'.
    expect(sup.getRun(view.runId)!.status).toBe("cancelled");
    expect(attempts(db, view.runId)[0]?.status).toBe("cancelled");
  }, 30_000);

  test("cancelling a finished run is a no-op", async () => {
    const db = newDb();
    const sup = supervisorFor(evalTarget("process.stdout.write('ok')"), { db });
    const { view, settled } = await sup.startRun({ model: "fake-model", prompt: "hi" });
    await settled;
    sup.cancelRun(view.runId);
    expect(sup.getRun(view.runId)!.status).toBe("succeeded");
  }, 20_000);

  test("shutdown cancels every run this process still owns", async () => {
    const db = newDb();
    const sup = supervisorFor(evalTarget("setTimeout(() => {}, 60_000)"), { db });
    const a = await sup.startRun({ model: "fake-model", prompt: "one" });
    const b = await sup.startRun({ model: "fake-model", prompt: "two" });

    sup.shutdown();
    expect(sup.getRun(a.view.runId)!.status).toBe("cancelled");
    expect(sup.getRun(b.view.runId)!.status).toBe("cancelled");

    await Promise.all([a.settled, b.settled]);
    for (const runId of [a.view.runId, b.view.runId]) {
      const pid = attempts(db, runId)[0]?.pid;
      expect(pid).toBeGreaterThan(0);
      expect(await isDead(pid!)).toBe(true);
      expect(sup.getRun(runId)!.status).toBe("cancelled");
    }
  }, 30_000);
});

describe("waitForRun", () => {
  test("returns the terminal view once the run settles", async () => {
    const db = newDb();
    const sup = supervisorFor(evalTarget("setTimeout(() => process.stdout.write('late'), 400)"), { db });
    const { view, settled } = await sup.startRun({ model: "fake-model", prompt: "hi" });
    const waited = await sup.waitForRun(view.runId, 15_000);
    expect(waited.status).toBe("succeeded");
    expect(waited.output).toBe("late");
    await settled;
  }, 20_000);

  test("returns the latest non-terminal view when the budget runs out", async () => {
    const db = newDb();
    const sup = supervisorFor(evalTarget("setTimeout(() => process.stdout.write('late'), 1200)"), { db });
    const { view, settled } = await sup.startRun({ model: "fake-model", prompt: "hi" });
    const started = Date.now();
    const waited = await sup.waitForRun(view.runId, 200);
    expect(waited.status).toBe("running");
    expect(Date.now() - started).toBeLessThan(1_000);
    await settled;
    expect(sup.getRun(view.runId)!.status).toBe("succeeded");
  }, 20_000);

  test("an unknown run id is an error, not a silent hang", async () => {
    const sup = supervisorFor(evalTarget("process.stdout.write('ok')"), { db: newDb() });
    await expect(sup.waitForRun("run_missing", 50)).rejects.toThrow(/Unknown run/);
  });
});

describe("recoverOrphans", () => {
  function seedAttempt(
    db: Database,
    o: { pid?: number | null; status?: RunStatus; ageMs?: number } = {},
  ): string {
    const status = o.status ?? "running";
    const runId = newId("run");
    const created = new Date(Date.now() - (o.ageMs ?? 0)).toISOString();
    db.query(
      `INSERT INTO runs (id, model, app, slug, instance, prompt, cwd, status, created_at, updated_at)
       VALUES (?, 'fake-model', 'fake', 'fake/slug', 'default', 'p', '/tmp', ?, ?, ?)`,
    ).run(runId, status, created, created);
    db.query(
      "INSERT INTO attempts (id, run_id, seq, target, status, pid, started_at) VALUES (?, ?, 1, 'fake:default/fake/slug@a1+full', ?, ?, ?)",
    ).run(newId("att"), runId, status, o.pid ?? null, status === "queued" ? null : created);
    return runId;
  }

  const seedRunningAttempt = (db: Database, pid: number | null): string => seedAttempt(db, { pid });

  test("marks attempts whose process and group are gone as orphaned", async () => {
    const db = newDb();
    const dead = Bun.spawnSync({ cmd: [BUN, "-e", ""] });
    const runId = seedRunningAttempt(db, dead.pid);

    const sup = supervisorFor(evalTarget("process.stdout.write('ok')"), { db });
    const view = sup.getRun(runId)!;
    expect(view.status).toBe("orphaned");
    expect(view.attempts[0]?.status).toBe("orphaned");
    expect(view.attempts[0]?.error).toContain("already gone");
    expect(view.attempts[0]?.finishedAt).toBeDefined();
  });

  test("marks a running attempt with no recorded pid as orphaned", () => {
    const db = newDb();
    const runId = seedRunningAttempt(db, null);
    const sup = supervisorFor(evalTarget("process.stdout.write('ok')"), { db });
    expect(sup.getRun(runId)!.status).toBe("orphaned");
    expect(sup.getRun(runId)!.attempts[0]?.error).toContain("no pid recorded");
  });

  test("orphans an untracked but still-live group without killing it", async () => {
    const db = newDb();
    const child = spawn(BUN, ["-e", "setTimeout(() => {}, 10_000)"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const runId = seedRunningAttempt(db, child.pid!);

    const sup = supervisorFor(evalTarget("process.stdout.write('ok')"), { db });
    // Nobody owns it: its pipes died with the old supervisor, so its outcome
    // can never be recorded and 'running' would be a lie forever.
    const view = sup.getRun(runId)!;
    expect(view.status).toBe("orphaned");
    expect(view.attempts[0]?.error).toContain("may still be running");
    expect(view.attempts[0]?.error).toContain("NOT killed");

    // Environment transparency: Baton did not kill a process it does not own.
    expect(await isDead(child.pid!, 200)).toBe(false);
    process.kill(-child.pid!, "SIGKILL");
    expect(await isDead(child.pid!)).toBe(true);
  }, 20_000);

  test("sweeps a queued attempt abandoned before launch", () => {
    const db = newDb();
    const runId = seedAttempt(db, { status: "queued", ageMs: 120_000 });
    const sup = supervisorFor(evalTarget("process.stdout.write('ok')"), { db });
    const view = sup.getRun(runId)!;
    expect(view.status).toBe("orphaned");
    expect(view.attempts[0]?.status).toBe("orphaned");
    expect(view.attempts[0]?.error).toContain("still queued");
  });

  test("a queued attempt inside the grace period is left to its launcher", () => {
    const db = newDb();
    const runId = seedAttempt(db, { status: "queued" });
    const sup = supervisorFor(evalTarget("process.stdout.write('ok')"), { db });
    expect(sup.getRun(runId)!.status).toBe("queued");
  });

  test("a swept queued run stops looking like work in progress to a retry", () => {
    const db = newDb();
    const stale = seedAttempt(db, { status: "queued", ageMs: 120_000 });
    db.query("UPDATE runs SET idempotency_key = ? WHERE id = ?").run("k-retry", stale);
    const sup = supervisorFor(evalTarget("process.stdout.write('ok')"), { db });
    // A retry on that key still dedups — but onto a terminal run the caller can
    // see is dead, instead of one stuck 'queued' with nobody left to run it.
    expect(sup.getRun(stale)!.status).toBe("orphaned");
  });

  test("leaves attempts this supervisor owns alone", async () => {
    const db = newDb();
    const sup = supervisorFor(evalTarget("setTimeout(() => process.stdout.write('late'), 500)"), { db });
    const { view, settled } = await sup.startRun({ model: "fake-model", prompt: "hi" });
    sup.recoverOrphans();
    expect(sup.getRun(view.runId)!.status).toBe("running");
    await settled;
    expect(sup.getRun(view.runId)!.status).toBe("succeeded");
  }, 20_000);
});
