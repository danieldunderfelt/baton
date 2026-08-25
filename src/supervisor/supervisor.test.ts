import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { executeAdapter } from "../adapters/executor.ts";
import type { AdapterSpec } from "../adapters/types.ts";
import { recordAdmissionFailure } from "../quota/quota.ts";
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

/**
 * A stand-in for the pool policy: hands out targets in order, honouring the
 * `exclude` keys the supervisor passes, and refusing once they are spent —
 * exactly what selectTarget does when every candidate is used up.
 */
function poolResolver(targets: Target[]): TargetResolver {
  return {
    resolve: (_model, opts) => {
      const tried = new Set(opts.exclude ?? []);
      const next = targets.find(
        (t) =>
          (opts.instance === undefined || t.instance === opts.instance) &&
          !tried.has(`${t.spec.app}:${t.instance}`),
      );
      if (!next) throw new Error("No usable route: every pool candidate is spent.");
      return next;
    },
  };
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
    expect(run.policy_version).toBe(2);
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

describe("failover on admission failure", () => {
  /** The one string this fake app's adapter calls an admission refusal. */
  const REFUSAL = "usage limit reached";

  function poolTarget(instance: string, code: string): Target {
    return target(fakeSpec(["-e", code], { admissionFailurePatterns: [REFUSAL] }), instance);
  }

  const refusing = (instance: string): Target =>
    poolTarget(instance, `process.stderr.write('${REFUSAL} for this account\\n');process.exit(1)`);
  const answering = (instance: string, text: string): Target =>
    poolTarget(instance, `process.stdout.write('${text}')`);

  function poolSupervisor(db: Database, targets: Target[], init: Partial<SupervisorInit> = {}) {
    return new Supervisor({
      env: { ...process.env },
      hostCwd: import.meta.dir,
      resolver: poolResolver(targets),
      pollMs: 25,
      db,
      ...init,
    });
  }

  interface EventRow {
    instance: string;
    kind: string;
  }
  const events = (db: Database): EventRow[] =>
    db
      .query<EventRow, []>("SELECT instance, kind FROM quota_events ORDER BY id")
      .all();
  const cooling = (db: Database): string[] =>
    db
      .query<{ instance: string }, []>("SELECT instance FROM cooldowns ORDER BY instance")
      .all()
      .map((r) => r.instance);

  test("a refused instance cools down and the next one answers under the same run", async () => {
    const db = newDb();
    const sup = poolSupervisor(db, [refusing("acct-a"), answering("acct-b", "answer from b")]);

    const { view, settled } = await sup.startRun({ model: "fake-model", prompt: "hi" });
    await settled;

    const final = sup.getRun(view.runId)!;
    expect(final.status).toBe("succeeded");
    expect(final.output).toBe("answer from b");
    expect(final.error).toBeUndefined();
    expect(final.attempts.map((a) => [a.seq, a.status])).toEqual([
      [1, "failed"],
      [2, "succeeded"],
    ]);
    // Session affinity: each attempt row names the instance that ran it, and
    // the run itself now belongs to the one that answered.
    expect(final.attempts[0]!.target).toBe("fake:acct-a/fake/slug@a1+full");
    expect(final.attempts[1]!.target).toBe("fake:acct-b/fake/slug@a1+full");
    expect(final.instance).toBe("acct-b");
    expect(attempts(db, view.runId)).toHaveLength(2);

    // The refusal spent no quota but cooled the account; the answer spent one.
    expect(cooling(db)).toEqual(["acct-a"]);
    expect(events(db)).toEqual([
      { instance: "acct-a", kind: "admission_failure" },
      { instance: "acct-b", kind: "run" },
    ]);
  }, 30_000);

  test("a non-admission failure fails the run instead of replaying it elsewhere", async () => {
    const db = newDb();
    const sup = poolSupervisor(db, [
      poolTarget("acct-a", "process.stderr.write('boom\\n');process.exit(3)"),
      answering("acct-b", "never reached"),
    ]);

    const { view, settled } = await sup.startRun({ model: "fake-model", prompt: "hi" });
    await settled;

    const final = sup.getRun(view.runId)!;
    expect(final.status).toBe("failed");
    expect(final.error).toContain("exited with code 3");
    expect(final.attempts).toHaveLength(1);
    // Work may already have happened: nothing is cooled, the run counts.
    expect(cooling(db)).toEqual([]);
    expect(events(db)).toEqual([{ instance: "acct-a", kind: "run" }]);
  }, 30_000);

  test("exhausted candidates fail the run with an error that says why", async () => {
    const db = newDb();
    const sup = poolSupervisor(db, [refusing("acct-a"), refusing("acct-b")]);

    const { view, settled } = await sup.startRun({ model: "fake-model", prompt: "hi" });
    await settled;

    const final = sup.getRun(view.runId)!;
    expect(final.status).toBe("failed");
    expect(final.attempts.map((a) => a.status)).toEqual(["failed", "failed"]);
    expect(final.error).toContain(REFUSAL);
    expect(final.error).toContain("no other instance was eligible");
    // The first refusal's error stays a plain one: it did fail over.
    expect(final.attempts[0]!.error).not.toContain("no other instance");
    expect(cooling(db)).toEqual(["acct-a", "acct-b"]);
  }, 30_000);

  test("an explicitly requested instance is a pin: it never fails over", async () => {
    const db = newDb();
    const sup = poolSupervisor(db, [refusing("acct-a"), answering("acct-b", "answer from b")]);

    const { view, settled } = await sup.startRun({
      model: "fake-model",
      prompt: "hi",
      instance: "acct-a",
    });
    await settled;

    const final = sup.getRun(view.runId)!;
    expect(final.status).toBe("failed");
    expect(final.attempts).toHaveLength(1);
    expect(final.instance).toBe("acct-a");
  }, 30_000);

  test("success ends the strike chain: an earlier cooldown on that instance is cleared", async () => {
    const db = newDb();
    recordAdmissionFailure(db, "fake", "acct-b", nowIso(), "stale refusal");
    expect(cooling(db)).toEqual(["acct-b"]);

    const sup = poolSupervisor(db, [answering("acct-b", "fine now")]);
    const { view, settled } = await sup.startRun({ model: "fake-model", prompt: "hi" });
    await settled;

    expect(sup.getRun(view.runId)!.status).toBe("succeeded");
    expect(cooling(db)).toEqual([]);
  }, 30_000);

  test("every completed attempt records reliability against its own target", async () => {
    const db = newDb();
    const sup = poolSupervisor(db, [refusing("acct-a"), answering("acct-b", "ok")]);
    const { settled } = await sup.startRun({ model: "fake-model", prompt: "hi" });
    await settled;

    const rows = db
      .query<{ target: string; sum_w_ok: number; sum_w_fail: number }, []>(
        "SELECT target, sum_w_ok, sum_w_fail FROM reliability ORDER BY target",
      )
      .all();
    expect(rows).toEqual([
      { target: "fake:acct-a/fake/slug@a1+full", sum_w_ok: 0, sum_w_fail: 1 },
      { target: "fake:acct-b/fake/slug@a1+full", sum_w_ok: 1, sum_w_fail: 0 },
    ]);
  }, 30_000);

  test("a failover attempt inherits the finished attempt's concurrency slot", async () => {
    const db = newDb();
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(SETTING_MAX_CONCURRENT, "1");
    const sup = poolSupervisor(db, [refusing("acct-a"), answering("acct-b", "answer from b")]);

    const { view, settled } = await sup.startRun({ model: "fake-model", prompt: "hi" });
    await settled;
    expect(sup.getRun(view.runId)!.status).toBe("succeeded");
    expect(sup.getRun(view.runId)!.attempts).toHaveLength(2);
  }, 30_000);

  test("an admission pattern printed after work started fails the run, never replays it", async () => {
    const db = newDb();
    const STARTED = "<<tool call>>";
    const workedThenRefused = target(
      fakeSpec(
        ["-e", `process.stdout.write('${STARTED}\\n');process.stderr.write('${REFUSAL}\\n');process.exit(1)`],
        { admissionFailurePatterns: [REFUSAL], workStartedPatterns: [STARTED] },
      ),
      "acct-a",
    );
    const sup = poolSupervisor(db, [workedThenRefused, answering("acct-b", "must not run")]);

    const { view, settled } = await sup.startRun({ model: "fake-model", prompt: "hi" });
    await settled;

    // The callee had already begun: replaying the prompt elsewhere could
    // duplicate whatever side effects it produced before the limit hit.
    const final = sup.getRun(view.runId)!;
    expect(final.status).toBe("failed");
    expect(final.attempts).toHaveLength(1);
    expect(final.instance).toBe("acct-a");
    expect(cooling(db)).toEqual([]);
    // It also spent a window slot, unlike a genuine refusal.
    expect(events(db)).toEqual([{ instance: "acct-a", kind: "run" }]);
  }, 30_000);

  test("a cancelled attempt never fails over", async () => {
    const db = newDb();
    const sup = poolSupervisor(db, [
      poolTarget(
        "acct-a",
        `setTimeout(() => {process.stderr.write('${REFUSAL}');process.exit(1)}, 60_000)`,
      ),
      answering("acct-b", "must not run"),
    ]);

    const { view, settled } = await sup.startRun({ model: "fake-model", prompt: "hi" });
    for (let i = 0; i < 100 && attempts(db, view.runId)[0]?.pid == null; i++) await sleep(20);
    sup.cancelRun(view.runId);
    await settled;

    const final = sup.getRun(view.runId)!;
    expect(final.status).toBe("cancelled");
    expect(final.attempts).toHaveLength(1);
    expect(cooling(db)).toEqual([]);
  }, 30_000);
});

describe("evidence", () => {
  const quotaEvents = (db: Database): { instance: string; kind: string }[] =>
    db
      .query<{ instance: string; kind: string }, []>(
        "SELECT instance, kind FROM quota_events ORDER BY id",
      )
      .all();

  const reliability = (db: Database) =>
    db
      .query<{ target: string; sum_w_ok: number; sum_w_fail: number }, []>(
        "SELECT target, sum_w_ok, sum_w_fail FROM reliability ORDER BY target",
      )
      .all();

  test("the window slot is claimed at admission, while the callee is still running", async () => {
    const db = newDb();
    const sup = supervisorFor(evalTarget("setTimeout(() => process.stdout.write('slow'), 800)"), {
      db,
    });

    const { view, settled } = await sup.startRun({ model: "fake-model", prompt: "hi" });
    for (let i = 0; i < 100 && attempts(db, view.runId)[0]?.pid == null; i++) await sleep(20);

    // Mid-flight: a selection happening right now already sees the slot taken,
    // instead of piling onto an instance that looks untouched.
    expect(sup.getRun(view.runId)!.status).toBe("running");
    expect(quotaEvents(db)).toEqual([{ instance: "default", kind: "run" }]);

    await settled;
    expect(sup.getRun(view.runId)!.status).toBe("succeeded");
    // ...and completion does not count it a second time.
    expect(quotaEvents(db)).toEqual([{ instance: "default", kind: "run" }]);
  }, 30_000);

  test("a failure before the callee ran is neither quota nor reliability", async () => {
    const db = newDb();
    const sup = supervisorFor(evalTarget("process.stdout.write('never')"), {
      db,
      exec: () =>
        Promise.resolve({
          ok: false,
          started: false,
          exitCode: null,
          timedOut: false,
          rawTail: "",
          error: "spawn failed: ENOENT",
          durationMs: 0,
        }),
    });

    const { view, settled } = await sup.startRun({ model: "fake-model", prompt: "hi" });
    await settled;

    // Baton-side facts are Baton's: charging them to the target would teach the
    // ratings that a model is unreliable because a binary moved.
    expect(sup.getRun(view.runId)!.status).toBe("failed");
    expect(quotaEvents(db)).toEqual([]);
    expect(reliability(db)).toEqual([]);
  }, 20_000);

  test("a failure the callee actually produced is reliability against its target", async () => {
    const db = newDb();
    const sup = supervisorFor(evalTarget("process.exit(3)"), { db });
    const { settled } = await sup.startRun({ model: "fake-model", prompt: "hi" });
    await settled;
    expect(reliability(db)).toEqual([
      { target: "fake:default/fake/slug@a1+full", sum_w_ok: 0, sum_w_fail: 1 },
    ]);
  }, 20_000);

  test("a plain failure does not clear an existing cooldown — only a success does", async () => {
    const db = newDb();
    recordAdmissionFailure(db, "fake", "default", nowIso(), "429");
    const sup = supervisorFor(evalTarget("process.exit(3)"), { db });
    const { settled } = await sup.startRun({ model: "fake-model", prompt: "hi" });
    await settled;

    // A nonzero exit is not proof the account is healthy — a CLI that dies on
    // a quota page mid-run looks exactly like this. Only an answer is proof.
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM cooldowns").get()!.n).toBe(1);
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

  test("a queued attempt already holds a slot, so a racing launch is refused", async () => {
    const db = newDb();
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(SETTING_MAX_CONCURRENT, "1");
    const sup = supervisorFor(evalTarget("process.stdout.write('ok')"), { db });

    // Another process, caught between its insert and its flip to 'running'.
    const runId = newId("run");
    const now = nowIso();
    db.query(
      `INSERT INTO runs (id, model, app, slug, instance, prompt, cwd, status, created_at, updated_at)
       VALUES (?, 'fake-model', 'fake', 'fake/slug', 'default', 'p', '/tmp', 'queued', ?, ?)`,
    ).run(runId, now, now);
    db.query(
      "INSERT INTO attempts (id, run_id, seq, target, status) VALUES (?, ?, 1, 'fake:default/fake/slug@a1+full', 'queued')",
    ).run(newId("att"), runId);

    await expect(sup.startRun({ model: "fake-model", prompt: "two" })).rejects.toThrow(
      /concurrency cap.*is 1/s,
    );
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n).toBe(1);
  }, 20_000);

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

  test("a cancellation landing between the outcome and the commit stands", async () => {
    const db = newDb();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sup = supervisorFor(evalTarget("unused"), {
      db,
      exec: async () => {
        await gate;
        return {
          ok: true,
          started: true,
          output: "answer",
          exitCode: 0,
          timedOut: false,
          rawTail: "answer",
          durationMs: 5,
        };
      },
    });

    const { view, settled } = await sup.startRun({ model: "fake-model", prompt: "hi" });
    // Exactly the writes another process's cancelRun makes — this supervisor's
    // live entry never sees them, so it is still about to commit 'succeeded'.
    const now = nowIso();
    db.query(
      "UPDATE attempts SET status = 'cancelled', finished_at = ? WHERE run_id = ? AND status IN ('queued','running')",
    ).run(now, view.runId);
    db.query(
      "UPDATE runs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('queued','running')",
    ).run(now, view.runId);
    release();
    await settled;

    const final = sup.getRun(view.runId)!;
    expect(final.status).toBe("cancelled");
    expect(final.attempts[0]!.status).toBe("cancelled");
    // The outcome is still recorded against the attempt — just not as a status
    // that resurrects a run the caller stopped.
    expect(attempts(db, view.runId)[0]!.exit_code).toBe(0);
    expect(attempts(db, view.runId)[0]!.output).toBe("answer");
  }, 20_000);

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
    o: { pid?: number | null; status?: RunStatus; ageMs?: number; ownerPid?: number | null } = {},
  ): string {
    const status = o.status ?? "running";
    const runId = newId("run");
    const created = new Date(Date.now() - (o.ageMs ?? 0)).toISOString();
    db.query(
      `INSERT INTO runs (id, model, app, slug, instance, prompt, cwd, status, created_at, updated_at)
       VALUES (?, 'fake-model', 'fake', 'fake/slug', 'default', 'p', '/tmp', ?, ?, ?)`,
    ).run(runId, status, created, created);
    db.query(
      "INSERT INTO attempts (id, run_id, seq, target, status, pid, started_at, owner_pid) VALUES (?, ?, 1, 'fake:default/fake/slug@a1+full', ?, ?, ?, ?)",
    ).run(
      newId("att"),
      runId,
      status,
      o.pid ?? null,
      status === "queued" ? null : created,
      o.ownerPid ?? null,
    );
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

  test("leaves an attempt owned by another live Baton process untouched", async () => {
    // The dogfood bug: a callee Claude Code spawned its own `baton mcp` against
    // the same scope DB, whose recovery orphaned the CLI's in-flight run.
    const db = newDb();
    const owner = spawn(BUN, ["-e", "setTimeout(() => {}, 10_000)"], {
      detached: true,
      stdio: "ignore",
    });
    owner.unref();
    const runId = seedAttempt(db, { pid: 999_999_999, ownerPid: owner.pid! });

    const sup = supervisorFor(evalTarget("process.stdout.write('ok')"), { db });
    expect(sup.getRun(runId)!.status).toBe("running");

    // Same row, owner now dead: recovery may claim it.
    process.kill(-owner.pid!, "SIGKILL");
    expect(await isDead(owner.pid!)).toBe(true);
    sup.recoverOrphans();
    expect(sup.getRun(runId)!.status).toBe("orphaned");
  }, 20_000);

  test("a queued attempt of a live foreign owner survives past the grace period", () => {
    const db = newDb();
    // process.pid is a live process that is not this supervisor: good enough.
    const runId = seedAttempt(db, { status: "queued", ageMs: 120_000, ownerPid: process.pid });
    const sup = supervisorFor(evalTarget("process.stdout.write('ok')"), { db });
    expect(sup.getRun(runId)!.status).toBe("queued");
  });

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

describe("resumeRun", () => {
  const SESSION = "sess-1";
  /** First turn: answers, and reports the handle the app minted for it. */
  const FIRST = `process.stdout.write(JSON.stringify({session_id:'${SESSION}',text:'first answer'}))`;
  /** Resume turn: echoes the argv and the identity env it was handed. */
  const RESUMED = `process.stdout.write(JSON.stringify({session_id:'${SESSION}',argv:process.argv.slice(1),account:process.env.FAKE_ACCOUNT ?? null}))`;

  function resumableSpec(over: Partial<AdapterSpec> = {}): AdapterSpec {
    return fakeSpec(["-e", FIRST], {
      sessionRef: { kind: "json", path: "session_id" },
      resume: { argv: ["-e", RESUMED, "{sessionRef}", "{slug}"] },
      ...over,
    });
  }

  function defineInstance(db: Database, name: string, env: Record<string, string>): void {
    db.query("INSERT INTO instances (app, name, env, created_at) VALUES (?, ?, ?, ?)").run(
      "fake",
      name,
      JSON.stringify(env),
      nowIso(),
    );
  }

  /**
   * Session affinity's stand-in for the registry: `resolve` is what pool
   * balancing would answer, `pinned` is the lookup a resume must use instead.
   */
  function affinityResolver(
    balanced: Target,
    pool: Target[],
  ): TargetResolver & { balancedCalls: number } {
    return {
      balancedCalls: 0,
      resolve(this: { balancedCalls: number }) {
        this.balancedCalls += 1;
        return balanced;
      },
      pinned(ref) {
        const found = pool.find((t) => t.spec.app === ref.app && t.instance === ref.instance);
        if (!found) throw new Error(`no target for ${ref.app}:${ref.instance}`);
        return found;
      },
    };
  }

  function affinitySupervisor(db: Database, resolver: TargetResolver): Supervisor {
    return new Supervisor({
      env: { ...process.env },
      hostCwd: import.meta.dir,
      resolver,
      pollMs: 25,
      db,
    });
  }

  /** A run on `instance` that finished and left a session handle behind. */
  async function originRun(
    db: Database,
    instance: string,
    spec = resumableSpec(),
  ): Promise<{ sup: Supervisor; runId: string }> {
    const t = target(spec, instance);
    const sup = affinitySupervisor(db, affinityResolver(t, [t]));
    const { view, settled } = await sup.startRun({
      model: "fake-model",
      prompt: "first prompt",
      category: "impl",
    });
    await settled;
    return { sup, runId: view.runId };
  }

  test("pins the original instance even when the pool would pick another", async () => {
    const db = newDb();
    defineInstance(db, "acct-a", { FAKE_ACCOUNT: "a" });
    defineInstance(db, "acct-b", { FAKE_ACCOUNT: "b" });
    const { runId } = await originRun(db, "acct-a");

    const spec = resumableSpec();
    const pinned = target(spec, "acct-a");
    const roomier = target(spec, "acct-b");
    const resolver = affinityResolver(roomier, [pinned, roomier]);
    const sup = affinitySupervisor(db, resolver);

    const { view, settled } = await sup.resumeRun({ runId, prompt: "second prompt" });
    await settled;

    const final = sup.getRun(view.runId)!;
    expect(final.status).toBe("succeeded");
    expect(final.instance).toBe("acct-a");
    expect(final.attempts[0]!.target).toBe("fake:acct-a/fake/slug@a1+full");
    // Balancing was never consulted: affinity is a lookup, not a preference.
    expect(resolver.balancedCalls).toBe(0);
    const echoed = JSON.parse(final.output!);
    // The resume argv ran, with the handle substituted as its own element, and
    // the callee saw acct-a's overlay — the config dir holding the session.
    expect(echoed.argv).toEqual([SESSION, "fake/slug"]);
    expect(echoed.account).toBe("a");
  }, 30_000);

  test("the resumed run is a new run that names the one it continues", async () => {
    const db = newDb();
    const { sup, runId } = await originRun(db, "default");

    const { view, settled } = await sup.resumeRun({ runId, prompt: "second prompt" });
    await settled;

    const final = sup.getRun(view.runId)!;
    expect(final.runId).not.toBe(runId);
    expect(final.resumedFrom).toBe(runId);
    expect(final.model).toBe("fake-model");
    expect(final.app).toBe("fake");
    expect(final.slug).toBe("fake/slug");
    expect(final.instance).toBe("default");
    expect(final.attempts).toHaveLength(1);
    // The original is untouched and still holds its own answer.
    const origin = sup.getRun(runId)!;
    expect(origin.resumedFrom).toBeUndefined();
    expect(origin.status).toBe("succeeded");
    expect(origin.output).toContain("first answer");
    const row = db
      .query<{ category: string | null; prompt: string; options: string }, [string]>(
        "SELECT category, prompt, options FROM runs WHERE id = ?",
      )
      .get(view.runId)!;
    expect(row.prompt).toBe("second prompt");
    expect(row.category).toBe("impl");
    expect(JSON.parse(row.options).resumed_from).toBe(runId);
  }, 30_000);

  test("the session handle is visible on both runs' attempts", async () => {
    const db = newDb();
    const { sup, runId } = await originRun(db, "default");
    expect(sup.getRun(runId)!.attempts[0]!.sessionRef).toBe(SESSION);

    const { view, settled } = await sup.resumeRun({ runId, prompt: "second prompt" });
    await settled;
    expect(sup.getRun(view.runId)!.attempts[0]!.sessionRef).toBe(SESSION);
  }, 30_000);

  test("refuses a run whose last attempt reported no session handle", async () => {
    const db = newDb();
    // Same app, but nothing to extract a handle from: the answer is plain text.
    const spec = resumableSpec({ invoke: fakeSpec(["-e", "process.stdout.write('plain')"]).invoke });
    const { sup, runId } = await originRun(db, "default", spec);

    await expect(sup.resumeRun({ runId, prompt: "again" })).rejects.toThrow(
      /reported no session handle/,
    );
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n).toBe(1);
  }, 30_000);

  test("refuses an adapter that declares no resume invocation", async () => {
    const db = newDb();
    const spec = resumableSpec();
    delete spec.resume;
    const { sup, runId } = await originRun(db, "default", spec);

    await expect(sup.resumeRun({ runId, prompt: "again" })).rejects.toThrow(
      /declares no non-interactive resume/,
    );
  }, 30_000);

  test("refuses when the instance holding the session is gone", async () => {
    const db = newDb();
    defineInstance(db, "acct-a", { FAKE_ACCOUNT: "a" });
    const { sup, runId } = await originRun(db, "acct-a");
    db.query("DELETE FROM instances WHERE app = ? AND name = ?").run("fake", "acct-a");

    await expect(sup.resumeRun({ runId, prompt: "again" })).rejects.toThrow(
      /instance 'fake:acct-a' is no longer defined/,
    );
    // Nothing was launched: the refusal happens before a run row exists.
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n).toBe(1);
  }, 30_000);

  test("refuses a run that is still in flight", async () => {
    const db = newDb();
    const { sup, runId } = await originRun(db, "default");
    db.query("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);

    // The callee still owns that session on disk; a second turn would race it.
    await expect(sup.resumeRun({ runId, prompt: "again" })).rejects.toThrow(/still running/);
  }, 30_000);

  test("refuses an unknown run", async () => {
    const db = newDb();
    const t = target(resumableSpec());
    const sup = affinitySupervisor(db, affinityResolver(t, [t]));
    await expect(sup.resumeRun({ runId: "run_nope", prompt: "hi" })).rejects.toThrow(
      /Unknown run 'run_nope'/,
    );
  });

  test("an admission refusal ends a resumed run instead of moving it", async () => {
    const db = newDb();
    const REFUSAL = "usage limit reached";
    defineInstance(db, "acct-a", { FAKE_ACCOUNT: "a" });
    defineInstance(db, "acct-b", { FAKE_ACCOUNT: "b" });
    const { runId } = await originRun(
      db,
      "acct-a",
      resumableSpec({ admissionFailurePatterns: [REFUSAL] }),
    );

    const refusing = target(
      resumableSpec({
        admissionFailurePatterns: [REFUSAL],
        resume: {
          argv: ["-e", `process.stderr.write('${REFUSAL}\\n');process.exit(1)`, "{sessionRef}"],
        },
      }),
      "acct-a",
    );
    const roomier = target(resumableSpec({ admissionFailurePatterns: [REFUSAL] }), "acct-b");
    const sup = affinitySupervisor(db, affinityResolver(roomier, [refusing, roomier]));

    const { view, settled } = await sup.resumeRun({ runId, prompt: "again" });
    await settled;

    const final = sup.getRun(view.runId)!;
    expect(final.status).toBe("failed");
    expect(final.attempts).toHaveLength(1);
    expect(final.instance).toBe("acct-a");
    expect(final.error).toContain("stays on the instance holding its session");
  }, 30_000);

  test("the concurrency cap counts a resume like any other launch", async () => {
    const db = newDb();
    const { sup, runId } = await originRun(db, "default");
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(SETTING_MAX_CONCURRENT, "1");
    // Someone else's attempt is already holding the scope's only slot.
    const otherRun = newId("run");
    db.query(
      `INSERT INTO runs (id, model, app, slug, instance, prompt, cwd, status, created_at, updated_at)
       VALUES (?, 'fake-model', 'fake', 'fake/slug', 'default', 'p', '/tmp', 'running', ?, ?)`,
    ).run(otherRun, nowIso(), nowIso());
    db.query(
      "INSERT INTO attempts (id, run_id, seq, target, status) VALUES (?, ?, 1, 'fake:default/fake/slug@a1+full', 'running')",
    ).run(newId("att"), otherRun);

    await expect(sup.resumeRun({ runId, prompt: "again" })).rejects.toThrow(
      /concurrency cap/,
    );
  }, 30_000);
});
