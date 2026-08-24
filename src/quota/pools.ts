import type { Database } from "bun:sqlite";

import { getAdapter } from "../adapters/builtin/index.ts";
import { DEFAULT_INSTANCE } from "../registry/registry.ts";
import { nowIso } from "../store/store.ts";
import { snapshot } from "./quota.ts";
import {
  PRECIOUSNESS_FACTOR,
  SETTING_PRECIOUSNESS_PREFIX,
  type Pool,
  type Preciousness,
} from "./types.ts";

/**
 * Instance pools and headroom-weighted spreading (PLAN.md §Instance pools).
 * Pool membership is user-defined config: Baton trusts it, as it trusts the
 * rest of the environment. This module only ranks — it never spawns, and it
 * never removes a candidate; the supervisor decides what to do with cooling
 * members and last-resort ones.
 */

export interface PoolCandidate {
  instance: string;
  /**
   * False when this scope has no `instances` row behind the name — a pool
   * member left dangling by a removal. Running it would silently apply an empty
   * overlay, i.e. the inherited account under a second name, so selection must
   * refuse it rather than guess.
   */
  defined: boolean;
  /** Set while an admission failure is still cooling this instance down. */
  coolingUntil?: string;
  headroom: number;
  preciousness: Preciousness;
  /** headroom × preciousness factor — higher is preferred, ties break by order. */
  weight: number;
  /** "emergency only": eligible only when every other candidate is out. */
  excludedUnlessLastResort: boolean;
}

/**
 * Defines the pool for an app. Members are instance names; `default` (the
 * inherited environment as-is) is always a legal member. Order is preserved as
 * the stable tie-break preference.
 */
export function setPool(db: Database, app: string, members: string[]): Pool {
  const deduped = [...new Set(members)];
  if (deduped.length === 0) {
    throw new Error(
      `Pool for app '${app}' needs at least one member. Use '${DEFAULT_INSTANCE}' for the inherited environment.`,
    );
  }
  requireIdentityEnv(app, `Pool for app '${app}'`);
  const unknown = deduped.filter((m) => m !== DEFAULT_INSTANCE && !instanceExists(db, app, m));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown instance${unknown.length > 1 ? "s" : ""} ${unknown.map((m) => `'${m}'`).join(", ")} for app '${app}' in this scope. Add one with 'baton instance add ${app} <name> --env ...'.`,
    );
  }
  db.query(
    `INSERT INTO pools (app, members, created_at) VALUES (?, ?, ?)
     ON CONFLICT (app) DO UPDATE SET members = excluded.members`,
  ).run(app, JSON.stringify(deduped), nowIso());
  return { app, members: deduped };
}

/**
 * Instances and pools only mean anything for an app whose identity can be
 * relocated by an env var: without one, every "instance" is the same account
 * under another name, and spreading across them would drain one window while
 * pretending to balance (PLAN.md §Instance mechanics — opencode, cursor).
 * Unknown apps are not this check's business; the CLI rejects them by name.
 */
export function requireIdentityEnv(app: string, subject: string): void {
  const spec = getAdapter(app);
  if (!spec || spec.identityEnv) return;
  throw new Error(
    `${subject} is not possible: '${app}' has no identity env var, so every instance of it is the same account. Its only instance is '${DEFAULT_INSTANCE}' (the inherited environment).`,
  );
}

/**
 * Drops an instance from every pool that names it, returning the apps whose
 * membership changed. A pool entry with no instance definition behind it is a
 * selection dead end (see `candidatesFor`), so removing an instance has to
 * remove its pool references too.
 */
export function removeFromPools(db: Database, app: string, instance: string): string[] {
  const changed: string[] = [];
  for (const pool of listPools(db)) {
    if (pool.app !== app || !pool.members.includes(instance)) continue;
    const rest = pool.members.filter((m) => m !== instance);
    if (rest.length === 0) clearPool(db, pool.app);
    else {
      db.query("UPDATE pools SET members = ? WHERE app = ?").run(JSON.stringify(rest), pool.app);
    }
    changed.push(pool.app);
  }
  return changed;
}

export function getPool(db: Database, app: string): Pool | undefined {
  const row = db
    .query<{ members: string }, [string]>("SELECT members FROM pools WHERE app = ?")
    .get(app);
  return row ? { app, members: JSON.parse(row.members) as string[] } : undefined;
}

export function clearPool(db: Database, app: string): boolean {
  return db.query("DELETE FROM pools WHERE app = ?").run(app).changes > 0;
}

export function listPools(db: Database): Pool[] {
  return db
    .query<{ app: string; members: string }, []>("SELECT app, members FROM pools ORDER BY app")
    .all()
    .map((r) => ({ app: r.app, members: JSON.parse(r.members) as string[] }));
}

/**
 * Candidates for this run, in the plan's precedence order: explicit instance
 * argument > pool balancing > default. Each is annotated with what selection
 * needs — cooldown, observed headroom, user-owned preciousness and the derived
 * weight — leaving member order intact so equal weights break deterministically.
 */
export function candidatesFor(
  db: Database,
  app: string,
  explicitInstance: string | undefined,
  nowIso: string,
): PoolCandidate[] {
  const members = explicitInstance
    ? [explicitInstance]
    : (getPool(db, app)?.members ?? [DEFAULT_INSTANCE]);
  return members.map((instance) => {
    const observed = snapshot(db, app, instance, nowIso);
    const preciousness = preciousnessFor(db, app, instance);
    return {
      instance,
      defined: instance === DEFAULT_INSTANCE || instanceExists(db, app, instance),
      ...(observed.coolingUntil ? { coolingUntil: observed.coolingUntil } : {}),
      headroom: observed.headroom,
      preciousness,
      weight: observed.headroom * PRECIOUSNESS_FACTOR[preciousness],
      excludedUnlessLastResort: preciousness === "emergency",
    };
  });
}

/** User-owned, per (app, instance); unset means "burn freely". */
export function preciousnessFor(db: Database, app: string, instance: string): Preciousness {
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?")
    .get(preciousnessKey(app, instance));
  return isPreciousness(row?.value) ? row.value : "burn";
}

export function preciousnessKey(app: string, instance: string): string {
  return `${SETTING_PRECIOUSNESS_PREFIX}${app}:${instance}`;
}

function isPreciousness(value: unknown): value is Preciousness {
  return typeof value === "string" && value in PRECIOUSNESS_FACTOR;
}

function instanceExists(db: Database, app: string, name: string): boolean {
  return Boolean(
    db
      .query<{ name: string }, [string, string]>(
        "SELECT name FROM instances WHERE app = ? AND name = ?",
      )
      .get(app, name),
  );
}
