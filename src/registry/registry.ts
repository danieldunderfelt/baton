import type { Database } from "bun:sqlite";

import { AUTONOMY_ORDER, type AdapterSpec, type Autonomy } from "../adapters/types.ts";
import { builtinAdapters } from "../adapters/builtin/index.ts";
import { blend } from "../eval/decay.ts";
import { effectiveRatings, targetRatings } from "../eval/evalStore.ts";
import { candidatesFor, getPool } from "../quota/pools.ts";
import { snapshot } from "../quota/quota.ts";
import type { Preciousness } from "../quota/types.ts";
import { nowIso } from "../store/store.ts";
import { SETTING_MAX_AUTONOMY_PREFIX } from "../supervisor/types.ts";

/**
 * Registry: canonical model → routes → execution target (PLAN.md §Registry).
 * Selection is a versioned, deterministic policy; the version is recorded per
 * run so a policy change is visible in the evidence.
 *
 * v2: filter by availability and authority ceiling, then rank (route × instance)
 * pairs by quota headroom weighted by preciousness, then by rating, with a
 * stable tie-break. v1 took the first available route and the default instance.
 */
export const POLICY_VERSION = 2;

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
  /**
   * Every (route × instance) pair the policy weighed, in tie-break order —
   * why this target won, for run records and debugging. Absent on targets that
   * did not come from selectTarget (an explicit caller-supplied target).
   */
  considered?: Considered[];
}

/** Why a candidate was skipped in the first pass (see selectTarget's relaxation). */
type Block = "tried" | "undefined-instance" | "cooling" | "emergency";

export interface Considered {
  app: string;
  slug: string;
  instance: string;
  /**
   * headroom × preciousness, rounded to the ranking grid: the PRIMARY key.
   * See RANKING_GRID — quota decides first, rating only inside a grid cell.
   */
  quota: number;
  /** Rating multiplier for this execution target: the SECONDARY key. */
  rating: number;
  headroom: number;
  preciousness: Preciousness;
  coolingUntil?: string;
  /** First-pass exclusion. Set on the winner too when selection had to relax. */
  excluded?: string;
  chosen?: true;
}

export interface SelectOptions {
  /** Explicit instance argument: outranks pool balancing (PLAN.md §Precedence). */
  instance?: string;
  /** Selection time; injectable so quota windows are testable. */
  nowIso?: string;
  /** `<app>:<instance>` keys already attempted by this run — never re-selected. */
  exclude?: string[];
  /** Kind of work: ratings are kept per category, so ranking is too. */
  category?: string;
}

/** Blended prior + observed for a canonical model, reported separately. */
export interface ModelScores {
  observed: number | null;
  nEff: number;
  prior: number | null;
  blended: number | null;
}

export interface InstanceQuota {
  instance: string;
  headroom: number;
  coolingUntil?: string;
}

export interface ModelListing {
  model: string;
  app: string;
  slug: string;
  available: boolean;
  /** Why an unavailable route cannot be used right now. */
  degradedReason?: string;
  instance: string;
  /** 'rated' once any evidence or prior exists for the canonical model. */
  rating: "unrated" | "rated";
  scores: ModelScores;
  /** Per-instance quota view; present only where this app has a pool. */
  pool?: InstanceQuota[];
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

interface Candidate extends Considered {
  route: Route;
  binaryPath: string;
  /** `<app>:<instance>/<slug>@a<adapterVersion>` — what evidence attaches to. */
  fingerprint: string;
  /** Position in the pool's member list — the stable tie-break. */
  memberIndex: number;
  block?: Block;
}

/**
 * The grid quota headroom is compared on. PLAN.md's ranking is *staged* —
 * quota-headroom-weighted-by-preciousness first, rating second — but a raw
 * comparison of two floats makes the first stage decide everything, since two
 * instances are almost never bit-identical. Rounding to 0.01 (a hundredth of
 * the headroom range) says what "equal enough" means: differences that small
 * are noise from run counting, and rating gets the casting vote.
 */
export const RANKING_GRID = 0.01;

/**
 * Policy v2 (PLAN.md §Registry). Filter: the app's binary is on PATH, the
 * scope's authority ceiling is expressible, the instance is actually defined in
 * this scope, it is not cooling down, and it is not reserved for emergencies.
 * Rank: quota headroom × preciousness on the RANKING_GRID first, then the
 * rating factor, then the deterministic order (app asc, pool member order,
 * slug asc) as the stable tie-break.
 *
 * When the filter empties the set, selection relaxes exactly once: to the
 * emergency-only members. A cooling instance is never relaxed onto — it is
 * still refusing admission, so running it buys another refusal and a longer
 * backoff; the run fails with the earliest retry time instead. An instance this
 * run already attempted is never re-admitted — that is what caps a failover
 * chain.
 */
export function selectTarget(db: Database, model: string, opts: SelectOptions = {}): Target {
  const now = opts.nowIso ?? nowIso();
  const tried = new Set(opts.exclude ?? []);
  const rating = ratingLens(db, model, opts.category ?? "", now);
  const candidates: Candidate[] = [];
  const blockedRoutes: string[] = [];

  for (const route of resolveTargets(model)) {
    const app = route.spec.app;
    const binaryPath = resolveBinary(route.spec.binary);
    if (binaryPath === null) {
      blockedRoutes.push(`${app}: ${MISSING_BINARY} ('${route.spec.binary}' is not on PATH)`);
      continue;
    }
    // A ceiling the adapter cannot express is an exclusion, not a broken route:
    // running anyway would hand the callee an authority Baton cannot constrain.
    const unsupported = unsupportedCeiling(route.spec, ceilingFor(db, app));
    if (unsupported) {
      blockedRoutes.push(`${app}: ${unsupported}`);
      continue;
    }
    const unknown = unknownInstance(db, app, opts.instance);
    if (unknown) {
      blockedRoutes.push(`${app}: ${unknown}`);
      continue;
    }
    candidatesFor(db, app, opts.instance, now).forEach((c, memberIndex) => {
      const block: Block | undefined = tried.has(candidateKey(app, c.instance))
        ? "tried"
        : !c.defined
          ? "undefined-instance"
          : c.coolingUntil
            ? "cooling"
            : c.excludedUnlessLastResort
              ? "emergency"
              : undefined;
      const fingerprint = `${app}:${c.instance}/${route.slug}@a${route.spec.adapterVersion}`;
      candidates.push({
        route,
        binaryPath,
        fingerprint,
        memberIndex,
        app,
        slug: route.slug,
        instance: c.instance,
        quota: onGrid(c.weight),
        rating: rating.factorFor(fingerprint),
        headroom: c.headroom,
        preciousness: c.preciousness,
        ...(c.coolingUntil ? { coolingUntil: c.coolingUntil } : {}),
        ...(block ? { block, excluded: blockReason(block, c.coolingUntil) } : {}),
      });
    });
  }
  candidates.sort(
    (a, b) =>
      a.app.localeCompare(b.app) || a.memberIndex - b.memberIndex || a.slug.localeCompare(b.slug),
  );

  const chosen =
    argmax(candidates.filter((c) => c.block === undefined)) ??
    argmax(candidates.filter((c) => c.block === "emergency"));
  if (!chosen) throw noCandidate(model, blockedRoutes, candidates);
  chosen.chosen = true;

  return {
    ...chosen.route,
    instance: chosen.instance,
    binaryPath: chosen.binaryPath,
    targetFingerprint: chosen.fingerprint,
    considered: candidates.map(publicView),
  };
}

/** Identity of a pool candidate across routes: what failover excludes. */
export function candidateKey(app: string, instance: string): string {
  return `${app}:${instance}`;
}

/**
 * Staged argmax over the already-sorted list: quota headroom (on the grid)
 * decides, rating breaks a grid tie, member order breaks the rest.
 */
function argmax(candidates: Candidate[]): Candidate | undefined {
  let best: Candidate | undefined;
  for (const c of candidates) {
    if (!best) {
      best = c;
      continue;
    }
    if (c.quota > best.quota || (c.quota === best.quota && c.rating > best.rating)) best = c;
  }
  return best;
}

/** Quota headroom is only compared to RANKING_GRID resolution. */
function onGrid(weight: number): number {
  return Math.round(weight / RANKING_GRID) * RANKING_GRID;
}

function blockReason(block: Block, until: string | undefined): string {
  switch (block) {
    case "tried":
      return "already attempted by this run";
    case "undefined-instance":
      return "pool member with no instance definition in this scope";
    case "cooling":
      return `cooling down until ${until} after an admission failure`;
    case "emergency":
      return "preciousness 'emergency': last resort only";
  }
}

function publicView(c: Candidate): Considered {
  const {
    route: _route,
    binaryPath: _binaryPath,
    fingerprint: _fingerprint,
    memberIndex: _i,
    block: _b,
    ...rest
  } = c;
  return rest;
}

/**
 * Maps a blended rating on the grade scale to a routing multiplier in
 * [RATING_FLOOR, 1]. Unrated is 1.0 on purpose: a model with no evidence must
 * not be starved of the runs that would produce some (PLAN.md §Layering).
 */
const RATING_FLOOR = 0.6;

/**
 * How much the canonical model's rating is worth when judging one of its
 * execution targets, in pseudo-observations. The model rating is the
 * hierarchical prior (PLAN.md §Registry): a target with no evidence of its own
 * lands exactly on it, and needs comparable evidence before it moves off.
 */
const MODEL_PRIOR_WEIGHT = 5;

interface RatingLens {
  /** Routing multiplier for one execution target. */
  factorFor(fingerprint: string): number;
}

/**
 * Ratings attach to execution targets, so every candidate is judged on its own
 * graded runs, shrunk toward the canonical model's blended rating. Without this
 * the rating term would be a common factor across a selection's candidates and
 * could not discriminate between them at all.
 *
 * Evidence is pooled across the autonomy levels a target ran at: autonomy is
 * resolved per route *after* selection, so the suffixed fingerprints the
 * supervisor writes are not yet knowable here. A category with no evidence
 * falls back to the model's uncategorised rating rather than to nothing.
 */
function ratingLens(db: Database, model: string, category: string, at: string): RatingLens {
  const ratings = effectiveRatings(db, at);
  const modelBlended =
    ratings.find((r) => r.model === model && r.category === category)?.blended ??
    ratings.find((r) => r.model === model && r.category === "")?.blended ??
    null;

  const evidence = new Map<string, { sumWg: number; sumW: number }>();
  for (const t of targetRatings(db, at)) {
    if (t.model !== model || t.category !== category || t.observed === null) continue;
    const key = routeKey(t.target);
    const acc = evidence.get(key) ?? { sumWg: 0, sumW: 0 };
    acc.sumWg += t.observed * t.weight;
    acc.sumW += t.weight;
    evidence.set(key, acc);
  }

  return {
    factorFor(fingerprint) {
      const acc = evidence.get(fingerprint);
      const observed = acc && acc.sumW > 0 ? acc.sumWg / acc.sumW : null;
      const blended = blend(observed, acc?.sumW ?? 0, modelBlended, MODEL_PRIOR_WEIGHT);
      if (blended === null) return 1;
      const clamped = Math.min(5, Math.max(1, blended));
      return RATING_FLOOR + ((clamped - 1) / 4) * (1 - RATING_FLOOR);
    },
  };
}

/** Drops the `+<autonomy>` the supervisor appends once authority is resolved. */
function routeKey(target: string): string {
  const plus = target.lastIndexOf("+");
  return plus === -1 ? target : target.slice(0, plus);
}

function noCandidate(model: string, blockedRoutes: string[], candidates: Candidate[]): Error {
  const reasons = [
    ...blockedRoutes,
    ...candidates.map((c) => `${c.app}:${c.instance}: ${c.excluded}`),
  ];
  const hints: string[] = [];
  if (blockedRoutes.length > 0) {
    hints.push(
      `Run 'baton detect' to see what is installed, or 'baton set ${SETTING_MAX_AUTONOMY_PREFIX}<app> <level>' to change a ceiling.`,
    );
  }
  // The one thing a caller can act on when everything is cooling is *when*.
  const earliest = earliestExpiry(candidates.filter((c) => c.block === "cooling"));
  if (earliest) {
    hints.push(`All instances cooling; earliest retry ${hhmm(earliest)} (${earliest}).`);
  }
  if (candidates.length > 0) {
    hints.push(
      "Every pool candidate is spent: wait for a cooldown to expire, or add an instance with 'baton instance add <app> <name> --env ...'.",
    );
  }
  return new Error(
    `No usable route for model '${model}' in this scope. ${reasons.join("; ")}. ${hints.join(" ")}`,
  );
}

function earliestExpiry(cooling: Candidate[]): string | undefined {
  let best: string | undefined;
  for (const c of cooling) {
    if (!best || Date.parse(c.coolingUntil!) < Date.parse(best)) best = c.coolingUntil;
  }
  return best;
}

/** Local wall-clock, because that is the clock the user is watching. */
function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const MISSING_BINARY = "binary not found";

/** The reason this ceiling is unrunnable on this adapter, or "" when it is fine. */
function unsupportedCeiling(spec: AdapterSpec, ceiling: Autonomy): string {
  if (spec.autonomyFlags[ceiling] !== undefined) return "";
  const supported = Object.keys(spec.autonomyFlags).join(", ") || "none";
  return `ceiling '${ceiling}' unsupported (supports: ${supported})`;
}

/**
 * Why this route cannot honour an explicit instance argument, or "" when it
 * can. A scope only knows the instances its own config dir defines, so this is
 * a per-route exclusion (another app may well define the same name), not a
 * global failure — the aggregate error still names it when nothing is left.
 */
function unknownInstance(db: Database, app: string, name: string | undefined): string {
  if (name === undefined || name === DEFAULT_INSTANCE) return "";
  const row = db
    .query<{ name: string }, [string, string]>(
      "SELECT name FROM instances WHERE app = ? AND name = ?",
    )
    .get(app, name);
  if (row) return "";
  const known = db
    .query<{ name: string }, [string]>("SELECT name FROM instances WHERE app = ? ORDER BY name")
    .all(app)
    .map((r) => r.name);
  const options = [DEFAULT_INSTANCE, ...known].join(", ");
  return `unknown instance '${name}' in this scope (known instances: ${options}). Add one with 'baton instance add ${app} ${name} --env ...'`;
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

export function listModels(db: Database, at = nowIso()): ModelListing[] {
  const scores = new Map(
    effectiveRatings(db, at)
      .filter((r) => r.category === "")
      .map(
        (r) =>
          [r.model, { observed: r.observed, nEff: r.nEff, prior: r.prior, blended: r.blended }] as const,
      ),
  );
  const rows: ModelListing[] = [];
  for (const spec of builtinAdapters) {
    const ceiling = ceilingFor(db, spec.app);
    const degradedReason =
      resolveBinary(spec.binary) === null ? MISSING_BINARY : unsupportedCeiling(spec, ceiling);
    // Only a pool makes per-instance headroom meaningful: without one there is
    // nothing to spread across, and 'default' is the whole story.
    const pool = getPool(db, spec.app)?.members.map((instance) => {
      const observed = snapshot(db, spec.app, instance, at);
      return {
        instance,
        headroom: observed.headroom,
        ...(observed.coolingUntil ? { coolingUntil: observed.coolingUntil } : {}),
      };
    });
    for (const route of spec.models) {
      const score = scores.get(route.model);
      rows.push({
        model: route.model,
        app: spec.app,
        slug: route.slug,
        available: degradedReason === "",
        ...(degradedReason === "" ? {} : { degradedReason }),
        instance: DEFAULT_INSTANCE,
        rating: score?.blended === undefined || score.blended === null ? "unrated" : "rated",
        scores: score ?? { observed: null, nEff: 0, prior: null, blended: null },
        ...(pool ? { pool } : {}),
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
