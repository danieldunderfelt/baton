import type { Database } from "bun:sqlite";

import {
  AUTONOMY_ORDER,
  DEFAULT_INSTANCE,
  type AdapterSpec,
  type Autonomy,
  type RouteSpec,
} from "../adapters/types.ts";
import { builtinAdapters } from "../adapters/builtin/index.ts";
import { activeDiscoveredSpecs } from "../discovery/discovery.ts";
import { blend } from "../eval/decay.ts";
import { effectiveRatings, targetRatings } from "../eval/evalStore.ts";
import { candidatesFor, getPool } from "../quota/pools.ts";
import { cooldownScopeFor, coolingUntil, snapshot } from "../quota/quota.ts";
import type { Preciousness } from "../quota/types.ts";
import { nowIso } from "../store/store.ts";
import { SETTING_MAX_AUTONOMY_PREFIX } from "../supervisor/types.ts";
import {
  blockFor,
  blockReason as routeBlockReason,
  globRegex,
  listBlocks,
  routeKey,
  type RouteBlock,
} from "./blocks.ts";
import { catalogOf, type Catalog } from "./catalog.ts";
import { probeVersion, type ProbeEnv } from "./probes.ts";

/**
 * Registry: canonical model → routes → execution target.
 * Selection is a versioned, deterministic policy; the version is recorded per
 * run so a policy change is visible in the evidence.
 *
 * v2: filter by availability and authority ceiling, then rank (route × instance)
 * pairs by quota headroom weighted by preciousness, then by rating, with a
 * stable tie-break. v1 took the first available route and the default instance.
 */
export const POLICY_VERSION = 2;

export { DEFAULT_INSTANCE };

export interface DetectedApp {
  app: string;
  /** Absolute path, or null when the binary is not on PATH in this scope. */
  binaryPath: string | null;
  version?: string;
}

export interface Route {
  spec: AdapterSpec;
  slug: string;
  /** Account restriction for models reported by only some instances. */
  instances?: string[];
}

export interface Target extends Route {
  instance: string;
  /** Absolute path of the verified binary, spawned instead of the bare name. */
  binaryPath: string;
  /**
   * `<app>:<instance>/<slug>@a<adapterVersion>+v<appVersion>`. The supervisor
   * appends `+<autonomy>` once the resolved authority is known — autonomy is
   * part of the execution-target identity but is not decided here.
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
type Block = "blocked" | "tried" | "undefined-instance" | "cooling" | "emergency";

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
  /** Restrict diagnostics or explicitly targeted work to this app. */
  app?: string;
  /** Explicit instance argument: outranks pool balancing. */
  instance?: string;
  /** Selection time; injectable so quota windows are testable. */
  nowIso?: string;
  /** `<app>:<instance>` keys already attempted by this run — never re-selected. */
  exclude?: string[];
  /** Kind of work: ratings are kept per category, so ranking is too. */
  category?: string;
  /**
   * Autonomy the caller asked for (the scope ceiling still clamps it). Only the
   * rating lens uses it here — the supervisor resolves the same value again for
   * the fingerprint it records — so ratings are read at the authority level the
   * run would actually use.
   */
  autonomy?: Autonomy;
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
  supportedAutonomies: Autonomy[];
  catalogError?: string;
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

/**
 * The apps this scope can reach. With a db, active discovered adapters are
 * included — otherwise `detect`/`list_models` would report an app roster that
 * contradicts the routes right beside it.
 */
export async function detectApps(
  opts: { probeVersion?: boolean; db?: Database } = {},
): Promise<DetectedApp[]> {
  const env = { ...process.env };
  const apps = await Promise.all(
    routableAdapters(opts.db).map(async (spec) => {
      const binaryPath = resolveBinary(spec.binary);
      const version =
        binaryPath && opts.probeVersion !== false ? await probeVersion(binaryPath, env) : undefined;
      return { app: spec.app, binaryPath, ...(version ? { version } : {}) };
    }),
  );
  return apps.sort((a, b) => a.app.localeCompare(b.app));
}

export async function targetFingerprint(
  app: string,
  instance: string,
  slug: string,
  adapterVersion: number,
  binaryPath: string,
  env: ProbeEnv = process.env,
): Promise<string> {
  const raw = await probeVersion(binaryPath, env);
  const version = raw?.replace(/[^A-Za-z0-9._-]+/g, "-") ?? "unknown";
  return `${app}:${instance}/${slug}@a${adapterVersion}+v${version}`;
}

/** Built-in adapters plus enabled registrations. */
export function routableAdapters(db?: Database): AdapterSpec[] {
  return db ? [...builtinAdapters, ...activeDiscoveredSpecs(db)] : [...builtinAdapters];
}

/**
 * The routes an app serves in this scope right now: the adapter's pinned ones
 * plus whatever its CLI reports. The CLI is the authority
 * on its own models, so a model released after the adapter was written routes
 * without a Baton change. `listingError` says why that half is missing.
 */
export async function catalogFor(
  spec: AdapterSpec,
  env: ProbeEnv = { ...process.env },
): Promise<Catalog> {
  return catalogOf(spec, resolveBinary(spec.binary), env);
}

export async function routesOf(spec: AdapterSpec, env?: ProbeEnv): Promise<RouteSpec[]> {
  return (await catalogFor(spec, env)).routes;
}

/**
 * The execution target a run already ran on — a LOOKUP, not a selection.
 * Session affinity must never consult the policy: a
 * resumed run belongs to the instance whose config dir holds its session, so
 * quota, ratings and pool balancing have no say. Throws with the reason when
 * the route no longer exists in this scope, which is the honest answer.
 */
export async function targetFor(
  ref: { app: string; slug: string; instance: string },
  db?: Database,
): Promise<Target> {
  const spec = routableAdapters(db).find((s) => s.app === ref.app);
  if (!spec) {
    throw new Error(
      `Cannot resume a '${ref.app}' run: no adapter for that app is registered in this scope.`,
    );
  }
  const binaryPath = resolveBinary(spec.binary);
  if (!binaryPath) {
    throw new Error(
      `Cannot resume a '${ref.app}' run: '${spec.binary}' is not on PATH in this scope.`,
    );
  }
  // Session affinity does not outrank a deny list: a route blocked after the
  // original run is one the user has said must not be spent again, and a resume
  // spends it exactly as a fresh run would.
  const blocked = db ? blockFor(listBlocks(db), ref.app, ref.instance, ref.slug) : undefined;
  if (blocked) {
    throw new Error(
      `Cannot resume this run: ${routeKey(ref.app, ref.instance, ref.slug)} is ${routeBlockReason(blocked)}. Remove it with 'baton block remove ${blocked.pattern}' if that is no longer what you want.`,
    );
  }
  return {
    spec,
    slug: ref.slug,
    instance: ref.instance,
    binaryPath,
    targetFingerprint: await targetFingerprint(
      ref.app,
      ref.instance,
      ref.slug,
      spec.adapterVersion,
      binaryPath,
      instanceEnvironment(db, spec.app, ref.instance),
    ),
  };
}

/**
 * Every route able to serve `model`, in deterministic order (app, then slug).
 * A model is named by its canonical id or by the app's own slug for it — the
 * slug is what the CLI reports, so it must always be a valid name.
 *
 * Pinned routes are tried first, on their own: they are the canonical ids, and
 * matching them needs no listing, so the common request never spawns an app.
 * Only a name no adapter pins consults what the apps report, plus each app's
 * `acceptsSlugs`: a matching name is passed through as the slug, and the app
 * decides whether it exists.
 */
export async function resolveTargets(
  model: string,
  db?: Database,
  opts: Pick<SelectOptions, "instance" | "app"> = {},
): Promise<Route[]> {
  const specs = routableAdapters(db).filter((spec) => !opts.app || spec.app === opts.app);
  const named = (routes: RouteSpec[]): RouteSpec[] =>
    routes.filter((r) => r.model === model || r.slug === model);
  const pinned = specs.flatMap((spec) =>
    named(spec.models).map((route) => ({ spec, slug: route.slug })),
  );
  if (pinned.length) return pinned.sort(routeOrder);
  const routes = (
    await Promise.all(
      specs.map(async (spec) => {
        const found = new Map<string, string[]>();
        for (const { instance, catalog } of await accountCatalogs(db, spec, opts.instance)) {
          for (const route of named(catalog.routes))
            found.set(route.slug, [...(found.get(route.slug) ?? []), instance]);
        }
        if (found.size === 0 && spec.acceptsSlugs?.some((glob) => globRegex(glob).test(model))) {
          return [{ spec, slug: model }];
        }
        return [...found].map(([slug, instances]) => ({ spec, slug, instances }));
      }),
    )
  ).flat();
  if (!routes.length) throw await unknownModel(model, db);
  return routes.sort(routeOrder);
}
function routeOrder(a: Route, b: Route): number {
  return a.spec.app.localeCompare(b.spec.app) || a.slug.localeCompare(b.slug);
}

/** The same inherited environment and named overlay used by delegated execution. */
export function instanceEnvironment(
  db: Database | undefined,
  app: string,
  instance: string,
  inherited: ProbeEnv = process.env,
): ProbeEnv {
  if (instance === DEFAULT_INSTANCE || !db) return { ...inherited };
  const row = db
    .query<{ env: string }, [string, string]>("SELECT env FROM instances WHERE app=? AND name=?")
    .get(app, instance);
  if (!row) throw new Error(`Unknown instance '${app}:${instance}'`);
  const parsed: unknown = JSON.parse(row.env);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((value) => typeof value !== "string")
  )
    throw new Error(`Invalid environment for '${app}:${instance}'`);
  const overlay: ProbeEnv = {};
  for (const [key, value] of Object.entries(parsed))
    if (typeof value === "string") overlay[key] = value;
  return { ...inherited, ...overlay };
}
function catalogInstances(
  db: Database | undefined,
  spec: AdapterSpec,
  explicit?: string,
): string[] {
  if (explicit) return [explicit];
  return (
    (db && spec.identityEnv ? getPool(db, spec.app)?.members : undefined) ?? [DEFAULT_INSTANCE]
  );
}
async function accountCatalogs(
  db: Database | undefined,
  spec: AdapterSpec,
  explicit?: string,
): Promise<Array<{ instance: string; catalog: Catalog }>> {
  const inherited = { ...process.env };
  return Promise.all(
    catalogInstances(db, spec, explicit).map(async (instance) => {
      try {
        return {
          instance,
          catalog: await catalogFor(spec, instanceEnvironment(db, spec.app, instance, inherited)),
        };
      } catch (error) {
        return {
          instance,
          catalog: {
            routes: spec.models,
            listingError: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }),
  );
}

interface Candidate extends Considered {
  route: Route;
  binaryPath: string;
  /** The route half of the execution-target identity — see targetFingerprint. */
  fingerprint: string;
  /** Position in the pool's member list — the stable tie-break. */
  memberIndex: number;
  block?: Block;
}

/**
 * The grid quota headroom is compared on. The ranking policy is *staged* —
 * quota-headroom-weighted-by-preciousness first, rating second — but a raw
 * comparison of two floats makes the first stage decide everything, since two
 * instances are almost never bit-identical. Rounding to 0.01 (a hundredth of
 * the headroom range) says what "equal enough" means: differences that small
 * are noise from run counting, and rating gets the casting vote.
 */
export const RANKING_GRID = 0.01;

/**
 * Policy v2. Filter: the app's binary is on PATH, the
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
export async function selectTarget(
  db: Database,
  model: string,
  opts: SelectOptions = {},
): Promise<Target> {
  const now = opts.nowIso ?? nowIso();
  const tried = new Set(opts.exclude ?? []);
  const rating = ratingLens(db, model, opts.category ?? "", now);
  const blocks = listBlocks(db);
  const candidates: Candidate[] = [];
  const blockedRoutes: string[] = [];

  for (const route of await resolveTargets(model, db, opts)) {
    const app = route.spec.app;
    const binaryPath = resolveBinary(route.spec.binary);
    if (binaryPath === null) {
      blockedRoutes.push(`${app}: ${MISSING_BINARY} ('${route.spec.binary}' is not on PATH)`);
      continue;
    }
    // A ceiling the adapter cannot express is an exclusion, not a broken route:
    // running anyway would hand the callee an authority Baton cannot constrain.
    const ceiling = ceilingFor(db, app);
    const autonomy = clampAutonomy(opts.autonomy, ceiling, route.spec.defaultAutonomy);
    const unsupported = unsupportedCeiling(route.spec, autonomy);
    if (unsupported) {
      blockedRoutes.push(`${app}: ${unsupported}`);
      continue;
    }
    const unknown = unknownInstance(db, app, opts.instance);
    if (unknown) {
      blockedRoutes.push(`${app}: ${unknown}`);
      continue;
    }
    // The authority this candidate would run at, resolved here so the rating
    // lens can ask for evidence produced at that same level.
    const accountCandidates = candidatesFor(
      db,
      app,
      poolInstance(route.spec, opts.instance),
      now,
      cooldownScopeFor(route.spec, route.slug),
    );
    for (const [memberIndex, c] of accountCandidates.entries()) {
      if (route.instances && !route.instances.includes(c.instance)) continue;
      // A deny-listed route is reported as its own exclusion rather than
      // folded into another: it is the user's standing decision, and it is the
      // one reason that survives every relaxation below.
      const denied = blockFor(blocks, app, c.instance, route.slug);
      const block: Block | undefined = denied
        ? "blocked"
        : tried.has(candidateKey(app, c.instance))
          ? "tried"
          : !c.defined
            ? "undefined-instance"
            : c.coolingUntil
              ? "cooling"
              : c.excludedUnlessLastResort
                ? "emergency"
                : undefined;
      const fingerprint = await targetFingerprint(
        app,
        c.instance,
        route.slug,
        route.spec.adapterVersion,
        binaryPath,
        c.defined ? instanceEnvironment(db, app, c.instance) : process.env,
      );
      candidates.push({
        route,
        binaryPath,
        fingerprint,
        memberIndex,
        app,
        slug: route.slug,
        instance: c.instance,
        quota: onGrid(c.weight),
        rating: rating.factorFor(fingerprint, autonomy),
        headroom: c.headroom,
        preciousness: c.preciousness,
        ...(c.coolingUntil ? { coolingUntil: c.coolingUntil } : {}),
        ...(block
          ? {
              block,
              excluded: denied ? routeBlockReason(denied) : blockReason(block, c.coolingUntil),
            }
          : {}),
      });
    }
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

/**
 * Pools only mean something for an app whose identity an env var can relocate:
 * without one every "instance" is the same account under another name. Built-in
 * pools are already refused at write time; a
 * discovered adapter's spec is what says whether it has one, so the gate lives
 * here too. Pinning the instance bypasses the pool without losing the explicit
 * argument's precedence.
 */
function poolInstance(spec: AdapterSpec, explicit: string | undefined): string | undefined {
  return spec.identityEnv ? explicit : (explicit ?? DEFAULT_INSTANCE);
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
    case "blocked":
      // Never reached: a route block carries the pattern and the user's reason.
      return "blocked by this scope's route deny list";
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
 * not be starved of the runs that would produce some.
 */
const RATING_FLOOR = 0.6;

/**
 * How much the canonical model's rating is worth when judging one of its
 * execution targets, in pseudo-observations. The model rating is the
 * hierarchical prior: a target with no evidence of its own
 * lands exactly on it, and needs comparable evidence before it moves off.
 */
const MODEL_PRIOR_WEIGHT = 5;

interface RatingLens {
  /** Routing multiplier for one execution target at the autonomy it would run at. */
  factorFor(fingerprint: string, autonomy: Autonomy): number;
}

/**
 * Ratings attach to execution targets, so every candidate is judged on its own
 * graded runs, shrunk toward the canonical model's blended rating. Without this
 * the rating term would be a common factor across a selection's candidates and
 * could not discriminate between them at all.
 *
 * The lens is autonomy-aware: the same model at another authority level is not
 * interchangeable evidence, so a candidate is judged on runs at the level it
 * would actually run at — but only once there is enough of it. Below
 * MODEL_PRIOR_WEIGHT the same-level evidence is thinner than the hierarchical
 * prior it would be shrunk against, and the level-pooled rating (a superset,
 * which includes it) is the better estimate. A category with no evidence falls
 * back to the model's uncategorised rating rather than to nothing.
 */
function ratingLens(db: Database, model: string, category: string, at: string): RatingLens {
  const ratings = effectiveRatings(db, at);
  const modelBlended =
    ratings.find((r) => r.model === model && r.category === category)?.blended ??
    ratings.find((r) => r.model === model && r.category === "")?.blended ??
    null;

  const evidence = new Map<string, { sumWg: number; sumW: number }>();
  const fold = (key: string, observed: number, weight: number): void => {
    const acc = evidence.get(key) ?? { sumWg: 0, sumW: 0 };
    acc.sumWg += observed * weight;
    acc.sumW += weight;
    evidence.set(key, acc);
  };
  for (const t of targetRatings(db, at)) {
    if (t.model !== model || t.category !== category || t.observed === null) continue;
    fold(lensKey(t.route, ""), t.observed, t.weight);
    if (t.autonomy !== "") fold(lensKey(t.route, t.autonomy), t.observed, t.weight);
  }

  return {
    factorFor(fingerprint, autonomy) {
      const sameLevel = evidence.get(lensKey(fingerprint, autonomy));
      const acc =
        sameLevel && sameLevel.sumW >= MODEL_PRIOR_WEIGHT
          ? sameLevel
          : evidence.get(lensKey(fingerprint, ""));
      const observed = acc && acc.sumW > 0 ? acc.sumWg / acc.sumW : null;
      const blended = blend(observed, acc?.sumW ?? 0, modelBlended, MODEL_PRIOR_WEIGHT);
      if (blended === null) return 1;
      const clamped = Math.min(5, Math.max(1, blended));
      return RATING_FLOOR + ((clamped - 1) / 4) * (1 - RATING_FLOOR);
    },
  };
}

/** Route, plus the autonomy segment — "" is the level-pooled bucket. */
function lensKey(route: string, autonomy: string): string {
  return `${route}+${autonomy}`;
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
  // A blocked route is not a spent one: nothing frees it but the user, so the
  // "wait or add an instance" advice would be wrong.
  if (candidates.some((c) => c.block === "blocked")) {
    hints.push(
      "Routes on this scope's deny list are never selected, not even as a last resort ('baton block list' shows them).",
    );
  }
  if (candidates.some((c) => c.block !== "blocked")) {
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
  return `autonomy '${ceiling}' unsupported (supports: ${supported})`;
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

export async function listModels(db: Database, at = nowIso()): Promise<ModelListing[]> {
  const scores = new Map(
    effectiveRatings(db, at)
      .filter((r) => r.category === "")
      .map((r) => [
        r.model,
        { observed: r.observed, nEff: r.nEff, prior: r.prior, blended: r.blended },
      ]),
  );
  const blocks = listBlocks(db);
  const rows = (
    await Promise.all(
      routableAdapters(db).map(async (spec) => {
        const catalogs = await accountCatalogs(db, spec);
        const routes = new Map<string, { route: RouteSpec; instances: string[]; error?: string }>();
        for (const { instance, catalog } of catalogs) {
          for (const route of catalog.routes) {
            const key = JSON.stringify([route.model, route.slug]);
            const entry = routes.get(key) ?? {
              route,
              instances: [],
              ...(catalog.listingError ? { error: catalog.listingError } : {}),
            };
            entry.instances.push(instance);
            routes.set(key, entry);
          }
        }
        const ceiling = ceilingFor(db, spec.app);
        const supportedAutonomies = AUTONOMY_ORDER.filter(
          (level) =>
            spec.autonomyFlags[level] !== undefined &&
            AUTONOMY_ORDER.indexOf(level) <= AUTONOMY_ORDER.indexOf(ceiling),
        );
        const defaultAutonomy = clampAutonomy(undefined, ceiling, spec.defaultAutonomy);
        const appReason =
          resolveBinary(spec.binary) === null
            ? MISSING_BINARY
            : unsupportedCeiling(spec, defaultAutonomy);
        return [...routes.values()].map(({ route, instances, error }): ModelListing => {
          const denied = instances.map((instance) =>
            blockFor(blocks, spec.app, instance, route.slug),
          );
          const degradedReason =
            denied[0] && denied.every(Boolean) ? routeBlockReason(denied[0]) : appReason;
          const pool =
            spec.identityEnv && getPool(db, spec.app)
              ? instances.map((instance) => {
                  const observed = snapshot(db, spec.app, instance, at);
                  const until = coolingUntil(
                    db,
                    spec.app,
                    instance,
                    at,
                    cooldownScopeFor(spec, route.slug),
                  );
                  return {
                    instance,
                    headroom: observed.headroom,
                    ...(until ? { coolingUntil: until } : {}),
                  };
                })
              : undefined;
          const score = scores.get(route.model);
          return {
            model: route.model,
            app: spec.app,
            slug: route.slug,
            available: !degradedReason,
            ...(degradedReason ? { degradedReason } : {}),
            instance: instances[0] ?? DEFAULT_INSTANCE,
            rating: score?.blended == null ? "unrated" : "rated",
            scores: score ?? { observed: null, nEff: 0, prior: null, blended: null },
            ...(pool ? { pool } : {}),
            maxAutonomy: ceiling,
            supportedAutonomies,
            ...(error ? { catalogError: error } : {}),
          };
        });
      }),
    )
  ).flat();
  return rows.sort((a, b) => byCodeUnits(a.model, b.model) || byCodeUnits(a.app, b.app));
}
function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function knownModels(db?: Database): Promise<string[]> {
  const models = new Set<string>();
  for (const spec of routableAdapters(db))
    for (const { catalog } of await accountCatalogs(db, spec))
      for (const r of catalog.routes) models.add(r.model);
  return [...models].sort();
}

/** An app can report hundreds of models; the error names the pinned ones and counts the rest. */
async function unknownModel(model: string, db?: Database): Promise<Error> {
  const pinned = new Set<string>();
  for (const spec of routableAdapters(db)) for (const r of spec.models) pinned.add(r.model);
  const more = (await knownModels(db)).length - pinned.size;
  const rest =
    more > 0 ? `, and ${more} more reported by the installed apps (see list_models)` : "";
  return new Error(
    `Unknown model '${model}'. Known models: ${[...pinned].sort().join(", ")}${rest}.`,
  );
}

function isAutonomy(value: unknown): value is Autonomy {
  return typeof value === "string" && (AUTONOMY_ORDER as string[]).includes(value);
}
