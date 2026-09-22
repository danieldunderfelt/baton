import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterSpec } from "../adapters/types.ts";
import { setDiscoveredEnabled, submitSpec } from "../discovery/discovery.ts";
import { addBlock } from "../registry/blocks.ts";
import { clearCatalogCache } from "../registry/catalog.ts";
import { openStore } from "../store/store.ts";
import { createSupervisor } from "./supervisor.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "baton-admission-"));
  const previousPath = process.env.PATH;
  const previousCacheHome = process.env.XDG_CACHE_HOME;
  process.env.PATH = "/nonexistent";
  process.env.XDG_CACHE_HOME = dir;
  clearCatalogCache();
  const pause = join(dir, "pause");
  const waiting = join(dir, "waiting");
  const release = join(dir, "release");
  const executed = join(dir, "executed");
  const binary = join(dir, "fake-agent");
  writeFileSync(binary, `#!/bin/sh
if [ "$1" = --version ]; then
  if [ -f '${pause}' ]; then
    echo waiting > '${waiting}'
    while [ ! -f '${release}' ]; do /bin/sleep 0.01; done
  fi
  echo version-1
else
  echo executed >> '${executed}'
  printf '{"answer":"ok","session":"session-1"}\\n'
fi
`, { mode: 0o755 });
  const spec: AdapterSpec = {
    app: "fake-agent", adapterVersion: 1, binary,
    models: [{ model: "fake-model", slug: "fake-model" }],
    invoke: { argv: ["{slug}"], promptVia: "stdin", extract: { kind: "json", path: "answer" } },
    sessionRef: { kind: "json", path: "session" },
    resume: { argv: ["resume", "{sessionRef}", "{slug}"] },
    autonomyFlags: { readonly: [], full: [] }, defaultAutonomy: "full",
    defaultTimeoutMs: 2000, admissionFailurePatterns: [],
  };
  const db = openStore(join(dir, "baton.db"));
  expect(submitSpec(db, spec).ok).toBe(true);
  const supervisor = createSupervisor({ db, env: { ...process.env }, hostCwd: dir });
  cleanup.push(async () => {
    writeFileSync(release, "go");
    await supervisor.shutdown();
    db.close();
    clearCatalogCache();
    process.env.PATH = previousPath;
    if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCacheHome;
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, spec, supervisor, pause, waiting, release, executed, binary };
}

async function waitForProbe(marker: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(10);
  expect(existsSync(marker)).toBe(true);
}

for (const change of ["block", "disable", "replace"] as const) {
  test(`a registration ${change} while discovery waits prevents execution`, async () => {
    const w = workspace();
    writeFileSync(w.pause, "pause");
    const pending = w.supervisor.startRun({ model: "fake-model", prompt: "local fake test" });
    await waitForProbe(w.waiting);
    if (change === "block") addBlock(w.db, "fake-agent", "blocked while discovery was pending");
    else if (change === "disable") setDiscoveredEnabled(w.db, "fake-agent", false);
    else expect(submitSpec(w.db, { ...w.spec, adapterVersion: 2 }).ok).toBe(true);
    writeFileSync(w.release, "go");
    const run = await pending;
    await run.settled;
    const final = w.supervisor.getRun(run.view.runId);
    expect(final?.status).toBe("failed");
    expect(final?.error).toContain(change === "block" ? "blocked by" : change === "disable" ? "disabled before execution" : "changed before execution");
    expect(existsSync(w.executed)).toBe(false);
    expect(w.db.query("SELECT COUNT(*) AS n FROM quota_events").get()).toEqual({ n: 0 });
  });
}

test("a block added during a resume probe prevents execution and releases its reservation", async () => {
  const w = workspace();
  const original = await w.supervisor.startRun({ model: "fake-model", prompt: "first" });
  await original.settled;
  expect(w.supervisor.getRun(original.view.runId)?.status).toBe("succeeded");
  rmSync(w.executed);
  writeFileSync(w.pause, "pause");
  const changed = new Date(Date.now() + 1000);
  utimesSync(w.binary, changed, changed);
  const pending = w.supervisor.resumeRun({ runId: original.view.runId, prompt: "second" });
  await waitForProbe(w.waiting);
  addBlock(w.db, "fake-agent", "blocked during resume discovery");
  writeFileSync(w.release, "go");
  const resumed = await pending;
  await resumed.settled;
  expect(w.supervisor.getRun(resumed.view.runId)?.status).toBe("failed");
  expect(w.supervisor.getRun(resumed.view.runId)?.error).toContain("blocked by");
  expect(existsSync(w.executed)).toBe(false);
  expect(w.db.query("SELECT COUNT(*) AS n FROM session_reservations").get()).toEqual({ n: 0 });
});

test("a ceiling lowered after options resolve is enforced before execution", async () => {
  const w = workspace();
  // This transaction commits between resolving options and invoking the executor.
  w.db.exec(`CREATE TRIGGER lower_ceiling AFTER INSERT ON attempts BEGIN
    INSERT INTO settings (key, value) VALUES ('max_autonomy:fake-agent', 'readonly');
  END`);
  const run = await w.supervisor.startRun({ model: "fake-model", prompt: "local fake test", options: { autonomy: "full" } });
  await run.settled;
  expect(w.supervisor.getRun(run.view.runId)?.status).toBe("failed");
  expect(w.supervisor.getRun(run.view.runId)?.error).toContain("exceeds the current 'readonly' ceiling");
  expect(existsSync(w.executed)).toBe(false);
});
