import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { probe, binaryStamp, environmentKey, type ProbeEnv } from "./probes.ts";

import { dotPath } from "../adapters/executor.ts";
import type { AdapterSpec, ModelsExtractSpec, RouteSpec } from "../adapters/types.ts";

/**
 * The model catalog of an app: what its CLI reports it can serve right now,
 * on top of the adapter's pinned routes. Routing follows the CLI, so a model
 * the app gained after the adapter was written is reachable under its own
 * slug with no change to Baton.
 *
 * Listing spawns the app (a second or two for the multi-provider ones), so
 * the answer is memoized: in memory for the daemon, and in a machine-wide
 * cache file for the short-lived CLI, which would otherwise pay the listing
 * on every invocation. An entry is good for CATALOG_TTL_MS and only while
 * the binary is the same file — an upgrade under a live process is a new
 * catalog. The cache is not scope state: the catalog is the binary's answer
 * for one identity, and the key carries both. A listing that fails does not
 * take the pinned routes with it; the failure is reported beside them.
 */

export const CATALOG_TTL_MS = 5 * 60_000;
/** A failed listing is retried sooner: the usual cause is transient. */
export const CATALOG_FAILURE_TTL_MS = 60_000;
/** Cache entries older than this are dropped on the next write, whatever they say. */
const CACHE_PRUNE_MS = 24 * 60 * 60_000;
const LIST_PROBE_MS = 15_000;
const STDERR_TAIL_CHARS = 200;

/**
 * What a reported slug may look like: the characters a route key can carry
 * (see blocks.ts PATTERN_CHARS, minus the wildcard). Anything else in a
 * listing is a banner, a table border or a display name, not a model.
 */
const SLUG_CHARS = /^[A-Za-z0-9_.:@+/-]+$/;

export interface Catalog {
  /** Pinned routes first, then every further slug the app reported. */
  routes: RouteSpec[];
  /** Why the app's own listing is missing from `routes`, when it is. */
  listingError?: string;
}

interface Listing {
  slugs?: string[];
  error?: string;
}

interface Entry extends Listing {
  /** mtime+size of the binary when it was asked, or null if it could not be stat'ed. */
  stamp: string | null;
  at: number;
}

let memory: Map<string, Entry> | undefined;

/** Forgets every memoized listing, in memory and on disk. For tests. */
export function clearCatalogCache(): void {
  memory = new Map();
  writeCacheFile(memory);
}

/** Forgets only the in-memory copy, as a new process starts. For tests. */
export function forgetCatalogMemory(): void {
  memory = undefined;
}

/** Every route this spec serves right now, given where its binary resolved to. */
export async function catalogOf(
  spec: AdapterSpec,
  binaryPath: string | null,
  env: ProbeEnv = { ...process.env },
): Promise<Catalog> {
  const routes = [...spec.models];
  if (!spec.listModels || binaryPath === null) return { routes };

  const listed = await cachedListing(
    [binaryPath, environmentKey(env), JSON.stringify(spec.listModels)].join("\0"),
    binaryPath,
    () => listSlugs(binaryPath, spec.listModels!.argv, spec.listModels!.extract, env),
  );
  // A reported slug that is already pinned keeps the pinned canonical id —
  // that is the id ratings and seeds attach to. One that collides with a pinned
  // id is skipped rather than allowed to shadow it.
  const taken = new Set(spec.models.flatMap((r) => [r.model, r.slug]));
  for (const slug of listed.slugs ?? []) {
    if (taken.has(slug)) continue;
    taken.add(slug);
    routes.push({ model: slug, slug });
  }
  return listed.error === undefined ? { routes } : { routes, listingError: listed.error };
}

const pending = new Map<string, Promise<Listing>>();
async function cachedListing(
  key: string,
  binaryPath: string,
  list: () => Promise<Listing>,
): Promise<Listing> {
  memory ??= readCacheFile();
  const stamp = binaryStamp(binaryPath);
  const cached = memory.get(key);
  if (
    cached &&
    (stamp === null || cached.stamp === stamp) &&
    Date.now() - cached.at < ttlOf(cached)
  ) {
    return cached;
  }
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const result = list()
    .then((fresh) => {
      memory!.set(key, { stamp, at: Date.now(), ...fresh });
      writeCacheFile(memory!);
      return fresh;
    })
    .finally(() => pending.delete(key));
  pending.set(key, result);
  return result;
}

function ttlOf(entry: Entry): number {
  return entry.error === undefined ? CATALOG_TTL_MS : CATALOG_FAILURE_TTL_MS;
}

/** `$XDG_CACHE_HOME/baton/catalog.json`, or `~/.cache/baton/catalog.json`. */
export function catalogCachePath(env: Record<string, string | undefined> = process.env): string {
  const root = env.XDG_CACHE_HOME ?? join(env.HOME ?? homedir(), ".cache");
  return join(root, "baton", "catalog.json");
}

function readCacheFile(): Map<string, Entry> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(catalogCachePath(), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entries = new Map<string, Entry>();
      for (const [key, entry] of Object.entries(parsed)) {
        if (
          !entry ||
          typeof entry !== "object" ||
          !("at" in entry) ||
          typeof entry.at !== "number" ||
          !("stamp" in entry) ||
          (entry.stamp !== null && typeof entry.stamp !== "string")
        )
          continue;
        if (
          "slugs" in entry &&
          Array.isArray(entry.slugs) &&
          entry.slugs.every((slug: unknown) => typeof slug === "string")
        )
          entries.set(key, { at: entry.at, stamp: entry.stamp, slugs: entry.slugs });
        else if ("error" in entry && typeof entry.error === "string")
          entries.set(key, { at: entry.at, stamp: entry.stamp, error: entry.error });
      }
      return entries;
    }
  } catch {
    // Missing or unreadable: the cache is a convenience, the listing is the truth.
  }
  return new Map();
}

/** Best effort: a cache that cannot be written only costs the next process a listing. */
function writeCacheFile(entries: Map<string, Entry>): void {
  const cutoff = Date.now() - CACHE_PRUNE_MS;
  const kept: Record<string, Entry> = {};
  for (const [key, entry] of entries) if (entry.at >= cutoff) kept[key] = entry;
  const path = catalogCachePath();
  try {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    // Rename is atomic, so a concurrent CLI never reads a half-written file.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(kept), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // Read-only home, full disk: nothing to do about it here.
  }
}

async function listSlugs(
  binaryPath: string,
  argv: string[],
  extract: ModelsExtractSpec,
  env: ProbeEnv,
): Promise<Listing> {
  const res = await probe(binaryPath, argv, env, LIST_PROBE_MS);
  if (res.exitCode !== 0 || res.timedOut) {
    const tail = res.stderr.trim().slice(-STDERR_TAIL_CHARS);
    const why = res.timedOut ? `timed out after ${LIST_PROBE_MS} ms` : `exit ${res.exitCode}`;
    return { error: `'${argv.join(" ")}' ${why}${tail ? `: ${tail}` : ""}` };
  }
  return parseSlugs(extract, res.stdout);
}

/** Lifts the slugs out of a listing command's stdout. Exported for tests. */
export function parseSlugs(extract: ModelsExtractSpec, stdout: string): Listing {
  const slugs: string[] = [];
  const keep = (value: unknown): void => {
    if (typeof value === "string" && SLUG_CHARS.test(value) && !slugs.includes(value)) {
      slugs.push(value);
    }
  };
  if (extract.kind === "lines") {
    for (const raw of stdout.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (extract.separator === undefined) {
        keep(line);
        continue;
      }
      const at = line.indexOf(extract.separator);
      if (at !== -1) keep(line.slice(0, at).trim());
    }
    return { slugs };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return { error: "listing is not valid JSON" };
  }
  const catalog = dotPath(doc, extract.path);
  const wanted = (entry: unknown): boolean =>
    extract.where === undefined ||
    String(dotPath(entry, extract.where.path)) === extract.where.equals;
  if (Array.isArray(catalog)) {
    for (const entry of catalog) {
      if (wanted(entry)) keep(extract.slug === undefined ? entry : dotPath(entry, extract.slug));
    }
  } else if (catalog !== null && typeof catalog === "object") {
    for (const [slug, entry] of Object.entries(catalog)) if (wanted(entry)) keep(slug);
  } else {
    return { error: `listing has no array or object at "${extract.path}"` };
  }
  return { slugs };
}
