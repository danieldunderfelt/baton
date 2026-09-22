import { afterAll, describe, expect, test } from "bun:test";
import { type Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterSpec } from "../adapters/types.ts";
import { groupAlive } from "../adapters/executor.ts";
import { newId, nowIso, openStore } from "../store/store.ts";
import { Supervisor, type TargetResolver } from "./supervisor.ts";
import type { Target } from "../registry/registry.ts";

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { force: true, recursive: true }); });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function scope(cap = 2000) {
  const dir = mkdtempSync(join(tmpdir(), "baton-runtime-"));
  dirs.push(dir);
  const path = join(dir, "baton.db");
  return { dir, path, db: openStore(path, cap) };
}
function spec(app = "fake", version = 1): AdapterSpec {
  return {
    app, adapterVersion: version, binary: process.execPath,
    models: [{ model: "test-model", slug: "test-slug" }],
    invoke: { argv: ["-e", `process.stdout.write(JSON.stringify({id:'same-session',text:'answer'}))`], promptVia: "stdin", extract: { kind: "json", path: "text" } },
    resume: { argv: ["-e", `process.stdout.write(JSON.stringify({id:'same-session',text:'continued'}))`, "{sessionRef}"] },
    sessionRef: { kind: "json", path: "id" },
    defaultAutonomy: "full", autonomyFlags: { readonly: [], edits: [], full: [] },
    admissionFailurePatterns: ["rate limit"],
  };
}
function target(spec: AdapterSpec): Target {
  return { spec, slug: "test-slug", instance: "default", binaryPath: spec.binary,
    targetFingerprint: `${spec.app}:default/test-slug@a${spec.adapterVersion}` };
}
function supervisor(db: Database, adapter = spec(), resolver?: TargetResolver): Supervisor {
  const t = target(adapter);
  return new Supervisor({ db, env: { ...process.env }, hostCwd: import.meta.dir, pollMs: 10,
    resolver: resolver ?? { resolve: async () => t, pinned: async () => t } });
}
async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await sleep(10);
  }
}

/** Runs a supervisor in another OS process against the same SQLite scope. */
function remoteOwner(dir: string, path: string, adapter: AdapterSpec, origin?: string) {
  const ready = join(dir, `${newId("ready")}.json`);
  const source = join(dir, `${newId("owner")}.ts`);
  writeFileSync(source, `
    import { openStore } from ${JSON.stringify(join(import.meta.dir, "../store/store.ts"))};
    import { Supervisor } from ${JSON.stringify(join(import.meta.dir, "supervisor.ts"))};
    import { writeFileSync } from 'node:fs';
    const spec = ${JSON.stringify(adapter)};
    const target = {spec,slug:'test-slug',instance:'default',binaryPath:spec.binary,targetFingerprint:spec.app+':default/test-slug@a'+spec.adapterVersion};
    const db = openStore(${JSON.stringify(path)});
    const supervisor = new Supervisor({db,env:process.env,hostCwd:${JSON.stringify(dir)},pollMs:10,
      resolver:{resolve:async()=>target,pinned:async()=>target}});
    const run = await ${origin
      ? `supervisor.resumeRun({runId:${JSON.stringify(origin)},prompt:'continue'})`
      : "supervisor.startRun({model:'test-model',prompt:'start'})"};
    writeFileSync(${JSON.stringify(ready)},JSON.stringify(run.view));
    await run.settled;
    db.close();
  `);
  const child = spawn(process.execPath, [source], { stdio: "ignore" });
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  return { ready, child, closed };
}

describe("runtime regressions", () => {
  test("cross-adapter failover retains the answering attempt's identity and settings for resume", async () => {
    const { db } = scope();
    const a = spec("fake-a", 1);
    a.defaultAutonomy = "readonly";
    a.defaultTimeoutMs = 1000;
    a.invoke.argv = ["-e", "process.stderr.write('rate limit');process.exit(1)"];
    const b = spec("fake-b", 7);
    b.defaultTimeoutMs = 5000;
    const resolver: TargetResolver = {
      resolve: async (_model, opts) => opts.exclude?.length ? target(b) : target(a),
      pinned: async (ref) => { expect(ref.app).toBe("fake-b"); return target(b); },
    };
    const sup = supervisor(db, b, resolver);
    const first = await sup.startRun({ model: "test-model", prompt: "hi" });
    await first.settled;
    const run = sup.getRun(first.view.runId)!;
    expect(run.app).toBe("fake-b");
    expect(run.options).toEqual({ autonomy: "full", timeoutMs: 5000 });
    const execution = db.query<{ execution: string }, [string]>("SELECT execution FROM attempts WHERE run_id = ? ORDER BY seq").all(run.runId).map(row => JSON.parse(row.execution));
    expect(execution[0]).toMatchObject({ adapter_version: 1, autonomy: "readonly", timeoutMs: 1000 });
    expect(execution[1]).toMatchObject({ adapter_version: 7, autonomy: "full", timeoutMs: 5000 });
    const resumed = await sup.resumeRun({ runId: run.runId, prompt: "continue" });
    await resumed.settled;
    expect(sup.getRun(resumed.view.runId)!.output).toBe("continued");
    db.close();
  });

  test("ancestor session reservations exclude competing resumes in another process", async () => {
    const { dir, path, db } = scope();
    const adapter = spec();
    adapter.resume = { argv: ["-e", `await Bun.sleep(400);process.stdout.write(JSON.stringify({id:'same-session',text:'continued'}))`, "{sessionRef}"] };
    const sup = supervisor(db, adapter);
    const a = await sup.startRun({ model: "test-model", prompt: "a" });
    await a.settled;
    const b = await sup.resumeRun({ runId: a.view.runId, prompt: "b" });
    await b.settled;
    const remote = remoteOwner(dir, path, adapter, b.view.runId);
    try {
      await until(() => existsSync(remote.ready));
      await expect(sup.resumeRun({ runId: a.view.runId, prompt: "racing ancestor" })).rejects.toThrow("already continuing that session");
      expect(await remote.closed).toBe(0);
      const next = await sup.resumeRun({ runId: a.view.runId, prompt: "now free" });
      await next.settled;
      expect(sup.getRun(next.view.runId)!.output).toBe("continued");
    } finally { remote.child.kill("SIGKILL"); db.close(); }
  });

  test("remote cancellation waits for the owner to stop the process and release its session", async () => {
    const { dir, path, db } = scope();
    const adapter = spec();
    const running = join(dir, "callee-ready");
    adapter.resume = { argv: ["-e", `process.on('SIGTERM',()=>{});await Bun.write(${JSON.stringify(running)},String(process.pid));await Bun.sleep(60000)`, "{sessionRef}"] };
    const sup = supervisor(db, adapter);
    const origin = await sup.startRun({ model: "test-model", prompt: "a" });
    await origin.settled;
    const remote = remoteOwner(dir, path, adapter, origin.view.runId);
    try {
      await until(() => existsSync(remote.ready) && existsSync(running));
      const runId: string = JSON.parse(readFileSync(remote.ready, "utf8")).runId;
      const pid = Number(readFileSync(running, "utf8"));
      sup.cancelRun(runId);
      await sleep(50);
      expect(sup.getRun(runId)!.status).toBe("running");
      expect(sup.getRun(runId)!.cancellationRequested).toBe(true);
      await expect(sup.resumeRun({ runId: origin.view.runId, prompt: "too early" })).rejects.toThrow("already continuing that session");
      expect((await sup.waitForRun(runId, 10000)).status).toBe("cancelled");
      expect(groupAlive(pid)).toBe(false);
      expect(db.query("SELECT * FROM session_reservations").all()).toEqual([]);
      expect(await remote.closed).toBe(0);
    } finally { remote.child.kill("SIGKILL"); db.close(); }
  }, 15000);

  test("cancellation never signals a PID recorded by an abandoned owner", async () => {
    const { db } = scope();
    const child = spawn(process.execPath, ["-e", "await Bun.sleep(60000)"], { detached: true, stdio: "ignore" });
    const pid = child.pid!;
    const runId = newId("run");
    const at = nowIso();
    db.query("INSERT INTO runs(id,model,app,slug,prompt,cwd,status,created_at,updated_at) VALUES (?,'test-model','fake','test-slug','hi','/tmp','running',?,?)").run(runId, at, at);
    db.query("INSERT INTO attempts(id,run_id,seq,target,status,pid,owner_pid) VALUES (?, ?, 1, 'fake', 'running', ?, 999999999)").run(newId("att"), runId, pid);
    try {
      const sup = supervisor(db);
      sup.cancelRun(runId);
      expect(sup.getRun(runId)!.status).toBe("orphaned");
      expect(groupAlive(pid)).toBe(true);
    } finally { process.kill(-pid, "SIGKILL"); db.close(); }
  });

  test("failed result writes reject settlement and can be retried without another execution", async () => {
    const { db } = scope();
    const sup = supervisor(db);
    db.exec("CREATE TRIGGER fail_outcome BEFORE UPDATE OF output ON attempts BEGIN SELECT RAISE(ABORT, 'disk fixture failure'); END");
    const run = await sup.startRun({ model: "test-model", prompt: "hi" });
    await expect(run.settled).rejects.toThrow("Could not persist the outcome");
    expect(() => sup.getRun(run.view.runId)).toThrow("result is retained");
    expect(db.query<{ status: string }, [string]>("SELECT status FROM runs WHERE id = ?").get(run.view.runId)!.status).toBe("failed");
    db.exec("DROP TRIGGER fail_outcome");
    const saved = sup.getRun(run.view.runId)!;
    expect(saved.status).toBe("succeeded");
    expect(saved.output).toBe("answer");
    expect(saved.attempts).toHaveLength(1);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM reliability").get()!.n).toBe(1);
    db.close();
  });

  test("a temporary write failure is retried automatically without replaying the callee", async () => {
    const { db } = scope();
    const sup = supervisor(db);
    db.exec("CREATE TRIGGER fail_outcome BEFORE UPDATE OF output ON attempts BEGIN SELECT RAISE(ABORT, 'temporary failure'); END");
    const run = await sup.startRun({ model: "test-model", prompt: "hi" });
    setTimeout(() => db.exec("DROP TRIGGER fail_outcome"), 40);
    await run.settled;
    expect(sup.getRun(run.view.runId)!.status).toBe("succeeded");
    expect(sup.getRun(run.view.runId)!.attempts).toHaveLength(1);
    db.close();
  });

  test("long-lived supervisors enforce the cap supplied to openStore after completions", async () => {
    const { db } = scope(2);
    const sup = supervisor(db);
    for (let i = 0; i < 5; i++) {
      const run = await sup.startRun({ model: "test-model", prompt: `turn ${i}` });
      await run.settled;
      expect(sup.getRun(run.view.runId)!.status).toBe("succeeded");
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n).toBeLessThanOrEqual(2);
    }
    db.close();
  });

  test("omitted resume options inherit while explicit changes still obey the current ceiling", async () => {
    const { db } = scope();
    const sup = supervisor(db);
    const first = await sup.startRun({ model: "test-model", prompt: "review", options: { autonomy: "readonly", timeoutMs: 5000 } });
    await first.settled;
    const inherited = await sup.resumeRun({ runId: first.view.runId, prompt: "review more" });
    await inherited.settled;
    expect(sup.getRun(inherited.view.runId)!.options).toEqual({ autonomy: "readonly", timeoutMs: 5000 });
    db.query("INSERT INTO settings VALUES ('max_autonomy:fake', 'edits')").run();
    const changed = await sup.resumeRun({ runId: first.view.runId, prompt: "implement", options: { autonomy: "full", timeoutMs: 10000 } });
    await changed.settled;
    expect(sup.getRun(changed.view.runId)!.options).toEqual({ autonomy: "edits", timeoutMs: 10000 });
    db.close();
  });

  test("active runs cannot evict a just-completed result before its caller reads it", async () => {
    const { db } = scope(1);
    const adapter = spec();
    adapter.invoke.argv = ["-e", `const prompt=await Bun.stdin.text();await Bun.sleep(prompt==='slow'?200:10);process.stdout.write(JSON.stringify({id:'session',text:prompt}))`];
    const sup = supervisor(db, adapter);
    const slow = await sup.startRun({ model: "test-model", prompt: "slow" });
    const fast = await sup.startRun({ model: "test-model", prompt: "fast" });
    await fast.settled;
    expect(sup.getRun(fast.view.runId)!.output).toBe("fast");
    expect(sup.getRun(slow.view.runId)!.status).toBe("running");
    await slow.settled;
    expect(sup.getRun(slow.view.runId)!.output).toBe("slow");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n).toBe(1);
    db.close();
  });

  test("the owner retries stored outcomes even when the reader uses another connection", async () => {
    const { path, db } = scope();
    const sup = supervisor(db);
    db.exec("CREATE TRIGGER fail_outcome BEFORE UPDATE OF output ON attempts BEGIN SELECT RAISE(ABORT, 'temporary storage failure'); END");
    const run = await sup.startRun({ model: "test-model", prompt: "hi" });
    await expect(run.settled).rejects.toThrow("Could not persist");
    const otherDb = openStore(path);
    const reader = supervisor(otherDb);
    expect(() => reader.getRun(run.view.runId)).toThrow("Could not persist");
    otherDb.exec("DROP TRIGGER fail_outcome");
    await until(() => otherDb.query<{ status: string }, [string]>("SELECT status FROM runs WHERE id = ?").get(run.view.runId)?.status === "succeeded");
    expect(reader.getRun(run.view.runId)!.output).toBe("answer");
    await sup.shutdown();
    otherDb.close();
    db.close();
  });

});
