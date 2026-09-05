import type { Database } from "bun:sqlite";

import type { RouteSpec } from "../adapters/types.ts";
import { nowIso, withBusyRetry } from "../store/store.ts";

/**
 * Route blocks: the user-owned deny list (PLAN.md §Registry: route blocks).
 *
 * Baton still does not verify identity — the environment is what runs, as it
 * would under a shell. This is the other half of that stance: since Baton
 * cannot tell whose subscription a route spends, the user gets a way to say
 * "never spend this one", and Baton obeys it without ever claiming to know why.
 * A block is config, written only through the trusted CLI, exactly like the
 * authority ceiling.
 *
 * A pattern addresses an execution target the same way the fingerprint does —
 * `<app>:<instance>/<slug>` — with `*` matching any run of characters:
 *
 *   opencode/github-copilot/*   every copilot route through opencode
 *   opencode/github-copilot/<slug>   just that one
 *   opencode                    the whole app
 *   codex:work/*                one instance of one app
 *
 * The instance segment defaults to `*`: a block is about a route, and a route
 * blocked on one account is almost never fine on another.
 */

export interface RouteBlock {
  /** Normalized `<app-glob>:<instance-glob>/<slug-glob>`. */
  pattern: string;
  /** Why, in the user's words — echoed wherever a block refuses something. */
  reason?: string;
  createdAt: string;
}

/**
 * Deliberately narrow: the characters real app ids, instance names and app
 * slugs use, plus `*`. Anything else (a space, a shell metacharacter, an escape
 * sequence) is a typo or an attempt to make the block list render as something
 * it is not — and a block that silently matches nothing is the failure mode
 * this feature can least afford.
 */
const PATTERN_CHARS = /^[A-Za-z0-9_.:@+\/*-]+$/;

/** `<app>:<instance>/<slug>` — what a pattern is matched against. */
export function routeKey(app: string, instance: string, slug: string): string {
  return `${app}:${instance}/${slug}`;
}

/**
 * Fills in the segments the user left off: a bare app blocks all of its routes,
 * and an omitted instance means every instance. Throws on anything unusable, so
 * a bad pattern fails at the CLI rather than quietly failing to block.
 */
export function normalizePattern(raw: string): string {
  const pattern = raw.trim();
  if (pattern === "") throw new Error("A block pattern cannot be empty.");
  if (!PATTERN_CHARS.test(pattern)) {
    throw new Error(
      `Invalid block pattern '${raw}': expected <app>[:<instance>]/<slug> with '*' wildcards, using only letters, digits and . _ - + @ : / *`,
    );
  }
  const slash = pattern.indexOf("/");
  const head = slash === -1 ? pattern : pattern.slice(0, slash);
  const slug = slash === -1 ? "*" : pattern.slice(slash + 1);
  if (head === "") throw new Error(`Invalid block pattern '${raw}': it names no app.`);
  if (slug === "") throw new Error(`Invalid block pattern '${raw}': it names no slug (use '*').`);
  return head.includes(":") ? `${head}/${slug}` : `${head}:*/${slug}`;
}

/** The first block that covers this execution target, or undefined. */
export function blockFor(
  blocks: RouteBlock[],
  app: string,
  instance: string,
  slug: string,
): RouteBlock | undefined {
  const key = routeKey(app, instance, slug);
  return blocks.find((b) => globRegex(b.pattern).test(key));
}

/** How a refusal reads, wherever one surfaces. */
export function blockReason(block: RouteBlock): string {
  return `blocked by '${block.pattern}'${block.reason ? ` (${block.reason})` : ""}`;
}

/**
 * The first route a canary may spend, on the inherited-environment instance it
 * runs in. Conformance is a real call on a real subscription, so it takes the
 * user's deny list as seriously as selection does: an adapter whose routes are
 * all blocked is not canaried, it is reported as blocked.
 */
export function canarySlug(
  blocks: RouteBlock[],
  app: string,
  models: RouteSpec[],
  instance: string,
): { slug: string } | { blocked: RouteBlock } | undefined {
  let denied: RouteBlock | undefined;
  for (const route of models) {
    const block = blockFor(blocks, app, instance, route.slug);
    if (!block) return { slug: route.slug };
    denied ??= block;
  }
  return denied ? { blocked: denied } : undefined;
}

const regexCache = new Map<string, RegExp>();

/** `*` matches any run of characters; everything else is literal. */
export function globRegex(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached) return cached;
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const regex = new RegExp(`^${source}$`);
  regexCache.set(pattern, regex);
  return regex;
}

/** Insertion order: the list is short, and the user's own order reads best. */
export function listBlocks(db: Database): RouteBlock[] {
  return db
    .query<{ pattern: string; reason: string | null; created_at: string }, []>(
      "SELECT pattern, reason, created_at FROM route_blocks ORDER BY created_at, pattern",
    )
    .all()
    .map((row) => ({
      pattern: row.pattern,
      ...(row.reason === null ? {} : { reason: row.reason }),
      createdAt: row.created_at,
    }));
}

/** Idempotent: re-adding a pattern refreshes its reason rather than failing. */
export function addBlock(db: Database, raw: string, reason?: string): RouteBlock {
  const pattern = normalizePattern(raw);
  const createdAt = nowIso();
  withBusyRetry(() =>
    db
      .query(
        `INSERT INTO route_blocks (pattern, reason, created_at) VALUES (?, ?, ?)
         ON CONFLICT (pattern) DO UPDATE SET reason = excluded.reason`,
      )
      .run(pattern, reason ?? null, createdAt),
  );
  return { pattern, ...(reason ? { reason } : {}), createdAt };
}

/** False when this scope had no such block — normalized, so the CLI form works. */
export function removeBlock(db: Database, raw: string): boolean {
  const pattern = normalizePattern(raw);
  return (
    withBusyRetry(() => db.query("DELETE FROM route_blocks WHERE pattern = ?").run(pattern))
      .changes > 0
  );
}
