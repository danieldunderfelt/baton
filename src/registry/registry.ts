import type { Database } from "bun:sqlite";

import { AUTONOMY_ORDER, type AdapterSpec, type Autonomy } from "../adapters/types.ts";
import { builtinAdapters } from "../adapters/builtin/index.ts";
import { SETTING_MAX_AUTONOMY_PREFIX } from "../supervisor/types.ts";

/**
 * Registry: canonical model → routes → execution target (PLAN.md §Registry).
 * Selection is a versioned, deterministic policy; the version is recorded per
 * run so a policy change is visible in the evidence.
 */
export const POLICY_VERSION = 1;

/** Instance meaning "the inherited environment as-is". Always exists. */
export const DEFAULT_INSTANCE = "default";

export interface DetectedApp {
  app: string;
  /** Absolute path, or null when the binary is not on PATH in this scope. */
  binaryPath: string | null;
  version?: string;
}

export interface Route {
  spec: AdapterSpec;
  slug: string;
}

export interface Target extends Route {
  instance: string;
  /** Absolute path of the verified binary, spawned instead of the bare name. */
  binaryPath: string;
  /**
   * `<app>:<instance>/<slug>@a<adapterVersion>`. The supervisor appends
   * `+<autonomy>` once the resolved authority is known — autonomy is part of
   * the execution-target identity but is not decided here.
   */
  targetFingerprint: string;
}

export interface ModelListing {
  model: string;
  app: string;
  slug: string;
  available: boolean;
  /** Why an unavailable route cannot be used right now. */
  degradedReason?: string;
  instance: string;
  /** Phase 2 fills this from the accumulator; phase 1 has no evidence. */
  rating: "unrated";
  maxAutonomy: Autonomy;
}

/**
 * Bun.which snapshots PATH at process start, so PATH is passed explicitly:
 * availability must follow the environment Baton inherited (and lets a scope
 * with a narrowed PATH see fewer apps). Deliberately uncached: Bun.which is a
 * cheap stat walk, and a cached "not installed" would outlive the install that
 * fixed it — list_models' ttlMs is the only caching promise Baton makes.
 */
function resolveBinary(binary: string): string | null {
  return Bun.which(binary, { PATH: process.env.PATH ?? "" });
}

export function detectApps(opts: { probeVersion?: boolean } = {}): DetectedApp[] {
  const probe = opts.probeVersion ?? true;
  return builtinAdapters
    .map((spec) => {
      const binaryPath = resolveBinary(spec.binary);
      const version = binaryPath && probe ? probeVersion(binaryPath) : undefined;
      return version ? { app: spec.app, binaryPath, version } : { app: spec.app, binaryPath };
    })
    .sort((a, b) => a.app.localeCompare(b.app));
}

/** Detect-path only: spawning per selection would be absurd. Never throws. */
function probeVersion(binaryPath: string): string | undefined {
  try {
    const res = Bun.spawnSync({
      cmd: [binaryPath, "--version"],
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
    });
    if (res.exitCode !== 0) return undefined;
    const line = res.stdout.toString().trim().split("\n")[0]?.trim();
    return line || undefined;
  } catch {
    return undefined;
  }
}

/** Every route able to serve `model`, in deterministic order (app, then slug). */
export function resolveTargets(model: string): Route[] {
  const routes: Route[] = [];
  for (const spec of builtinAdapters) {
    for (const route of spec.models) {
      if (route.model === model) routes.push({ spec, slug: route.slug });
    }
  }
  if (routes.length === 0) throw unknownModel(model);
  return routes.sort((a, b) => a.spec.app.localeCompare(b.spec.app) || a.slug.localeCompare(b.slug));
}

export function selectTarget(
  db: Database,
  model: string,
  opts: { instance?: string } = {},
): Target {
  const routes = resolveTargets(model);
  const candidates: { route: Route; binaryPath: string }[] = [];
  const excluded: string[] = [];
  for (const route of routes) {
    const binaryPath = resolveBinary(route.spec.binary);
    if (binaryPath === null) {
      excluded.push(`${route.spec.app}: ${MISSING_BINARY} ('${route.spec.binary}' is not on PATH)`);
      continue;
    }
    // A ceiling the adapter cannot express is an exclusion, not a broken route:
    // running anyway would hand the callee an authority Baton cannot constrain.
    const unsupported = unsupportedCeiling(route.spec, ceilingFor(db, route.spec.app));
    if (unsupported) {
      excluded.push(`${route.spec.app}: ${unsupported}`);
      continue;
    }
    candidates.push({ route, binaryPath });
  }
  if (candidates.length === 0) {
    throw new Error(
      `No usable route for model '${model}' in this scope. ${excluded.join("; ")}. Run 'baton detect' to see what is installed, or 'baton set ${SETTING_MAX_AUTONOMY_PREFIX}<app> <level>' to change a ceiling.`,
    );
  }

  // Policy v1: availability filter, then stable order (app asc), take first.
  // Phase 2 inserts ranking here — quota headroom weighted by preciousness,
  // then rating — keeping this same filter/rank/tie-break shape.
  const chosen = candidates[0]!;
  const instance = opts.instance ?? DEFAULT_INSTANCE;
  if (instance !== DEFAULT_INSTANCE) assertInstance(db, chosen.route.spec.app, instance);

  return {
    ...chosen.route,
    instance,
    binaryPath: chosen.binaryPath,
    targetFingerprint: `${chosen.route.spec.app}:${instance}/${chosen.route.slug}@a${chosen.route.spec.adapterVersion}`,
  };
}

const MISSING_BINARY = "binary not found";

/** The reason this ceiling is unrunnable on this adapter, or "" when it is fine. */
function unsupportedCeiling(spec: AdapterSpec, ceiling: Autonomy): string {
  if (spec.autonomyFlags[ceiling] !== undefined) return "";
  const supported = Object.keys(spec.autonomyFlags).join(", ") || "none";
  return `ceiling '${ceiling}' unsupported (supports: ${supported})`;
}

function assertInstance(db: Database, app: string, name: string): void {
  const row = db
    .query<{ name: string }, [string, string]>(
      "SELECT name FROM instances WHERE app = ? AND name = ?",
    )
    .get(app, name);
  if (row) return;
  const known = db
    .query<{ name: string }, [string]>("SELECT name FROM instances WHERE app = ? ORDER BY name")
    .all(app)
    .map((r) => r.name);
  const options = [DEFAULT_INSTANCE, ...known].join(", ");
  throw new Error(
    `Unknown instance '${name}' for app '${app}' in this scope. Known instances: ${options}. Add one with 'baton instance add ${app} ${name} --env ...'.`,
  );
}

/** User-owned authority ceiling for an app. Settable only via the trusted CLI. */
export function ceilingFor(db: Database, app: string): Autonomy {
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?")
    .get(`${SETTING_MAX_AUTONOMY_PREFIX}${app}`);
  return isAutonomy(row?.value) ? row.value : "full";
}

/** Options may narrow the ceiling, never raise it. */
export function clampAutonomy(
  requested: Autonomy | undefined,
  ceiling: Autonomy,
  specDefault: Autonomy,
): Autonomy {
  const want = requested ?? specDefault;
  return AUTONOMY_ORDER.indexOf(want) <= AUTONOMY_ORDER.indexOf(ceiling) ? want : ceiling;
}

export function listModels(db: Database): ModelListing[] {
  const ceilings = new Map<string, Autonomy>();
  const rows: ModelListing[] = [];
  for (const spec of builtinAdapters) {
    let ceiling = ceilings.get(spec.app);
    if (!ceiling) {
      ceiling = ceilingFor(db, spec.app);
      ceilings.set(spec.app, ceiling);
    }
    const degradedReason =
      resolveBinary(spec.binary) === null ? MISSING_BINARY : unsupportedCeiling(spec, ceiling);
    for (const route of spec.models) {
      rows.push({
        model: route.model,
        app: spec.app,
        slug: route.slug,
        available: degradedReason === "",
        ...(degradedReason === "" ? {} : { degradedReason }),
        instance: DEFAULT_INSTANCE,
        rating: "unrated",
        maxAutonomy: ceiling,
      });
    }
  }
  return rows.sort((a, b) => a.model.localeCompare(b.model) || a.app.localeCompare(b.app));
}

export function knownModels(): string[] {
  const models = new Set<string>();
  for (const spec of builtinAdapters) for (const r of spec.models) models.add(r.model);
  return [...models].sort();
}

function unknownModel(model: string): Error {
  return new Error(`Unknown model '${model}'. Known models: ${knownModels().join(", ")}.`);
}

function isAutonomy(value: unknown): value is Autonomy {
  return typeof value === "string" && (AUTONOMY_ORDER as string[]).includes(value);
}
