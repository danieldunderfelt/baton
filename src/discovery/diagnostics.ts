import type { Database } from "bun:sqlite";
import { getAdapter } from "../adapters/builtin/index.ts";
import { AUTONOMY_ORDER } from "../adapters/types.ts";
import { addBlock, removeBlock } from "../registry/blocks.ts";
import { ceilingFor, routableAdapters, selectTarget } from "../registry/registry.ts";
import { probeVersion } from "../registry/probes.ts";
import { createSupervisor, type AdapterExec } from "../supervisor/supervisor.ts";
import {
  CANARY_PROMPT,
  CANARY_TIMEOUT_MS,
  canonicalSpecJson,
  getDiscovered,
  setDiscoveredEnabled,
} from "./discovery.ts";
import { CANARY_TOKEN } from "./types.ts";

/** One enable/disable operation for built-in and registered adapters. */
export function setAdapterEnabled(db: Database, app: string, enabled: boolean): void {
  if (getDiscovered(db, app)) {
    setDiscoveredEnabled(db, app, enabled);
    return;
  }
  if (!getAdapter(app)) throw new Error(`Unknown adapter '${app}'.`);
  if (enabled) removeBlock(db, `${app}:*/*`);
  else addBlock(db, `${app}:*/*`, "adapter disabled");
}

export interface DiagnosticResult {
  app: string;
  passed: boolean;
  detail: string;
  runId?: string;
}

/** An optional real run, under the same routing and permission rules as any run. */
export async function testAdapter(
  db: Database,
  app: string,
  opts: { cwd?: string; instance?: string; exec?: AdapterExec } = {},
): Promise<DiagnosticResult> {
  const spec = routableAdapters(db).find((candidate) => candidate.app === app);
  if (!spec) throw new Error(`Adapter '${app}' is unknown or disabled.`);
  const ceiling = ceilingFor(db, app);
  const autonomy = AUTONOMY_ORDER.find(
    (level) =>
      AUTONOMY_ORDER.indexOf(level) <= AUTONOMY_ORDER.indexOf(ceiling) &&
      spec.autonomyFlags[level] !== undefined,
  );
  if (!autonomy)
    return { app, passed: false, detail: `No supported autonomy at or below '${ceiling}'.` };
  let model: string | undefined;
  let reason = "No available model route.";
  for (const route of spec.models) {
    try {
      await selectTarget(db, route.model, { app, instance: opts.instance, autonomy });
      model = route.model;
      break;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
  }
  if (!model) return { app, passed: false, detail: reason };
  const supervisor = createSupervisor({
    db,
    env: process.env,
    hostCwd: opts.cwd ?? process.cwd(),
    exec: opts.exec,
    resolver: { resolve: (id, selection) => selectTarget(db, id, { ...selection, app }) },
  });
  try {
    const run = await supervisor.startRun({
      model,
      prompt: CANARY_PROMPT,
      instance: opts.instance,
      options: { autonomy, timeoutMs: CANARY_TIMEOUT_MS },
    });
    await run.settled;
    const final = supervisor.getRun(run.view.runId);
    if (!final) throw new Error(`Diagnostic run '${run.view.runId}' is missing.`);
    const passed = final.status === "succeeded" && final.output?.trim() === CANARY_TOKEN;
    const detail = passed
      ? "Diagnostic passed."
      : (final.error ??
        `Expected '${CANARY_TOKEN}', received ${JSON.stringify(final.output ?? "")}.`);
    const version = await probeVersion(spec.binary);
    db.query(
      `UPDATE discovered_adapters SET tested_at = ?, test_passed = ?, binary_version = ?, notes = ?
      WHERE app = ? AND spec = ? AND status = 'enabled'`,
    ).run(
      new Date().toISOString(),
      passed ? 1 : 0,
      version ?? null,
      detail,
      app,
      canonicalSpecJson(spec),
    );
    return { app, passed, detail, runId: run.view.runId };
  } finally {
    await supervisor.shutdown();
  }
}
