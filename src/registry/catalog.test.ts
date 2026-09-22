import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdapterSpec, ListModelsSpec } from "../adapters/types.ts";
import {
  catalogCachePath,
  catalogOf,
  clearCatalogCache,
  forgetCatalogMemory,
  parseSlugs,
} from "./catalog.ts";
import { probeVersion } from "./probes.ts";

/**
 * The cache file is machine-wide, so every test points XDG_CACHE_HOME at its
 * own throwaway directory: nothing here touches the user's real cache.
 */
let cacheHome: string;
let previousCacheHome: string | undefined;
let fixtureDirs: string[] = [];

beforeEach(() => {
  previousCacheHome = process.env.XDG_CACHE_HOME;
  cacheHome = mkdtempSync(join(tmpdir(), "baton-catalog-cache-"));
  process.env.XDG_CACHE_HOME = cacheHome;
  clearCatalogCache();
});

afterEach(() => {
  clearCatalogCache();
  for (const dir of [cacheHome, ...fixtureDirs]) rmSync(dir, { recursive: true, force: true });
  fixtureDirs = [];
  if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = previousCacheHome;
});

/**
 * A fake CLI whose listing prints `stdout` and exits `code`, counting every
 * invocation in a file beside it so the cache can be observed.
 */
function fakeLister(stdout: string, code = 0): { binary: string; calls: () => number } {
  const dir = mkdtempSync(join(tmpdir(), "baton-catalog-bin-"));
  fixtureDirs.push(dir);
  const counter = join(dir, "calls");
  const binary = join(dir, "fake");
  writeFileSync(
    binary,
    `#!/bin/sh\necho x >> "${counter}"\ncat <<'BATON_EOF'\n${stdout}\nBATON_EOF\nexit ${code}\n`,
    { mode: 0o755 },
  );
  return {
    binary,
    calls: () => (existsSync(counter) ? readFileSync(counter, "utf8").split("x").length - 1 : 0),
  };
}

function spec(listModels: ListModelsSpec | undefined, identityEnv?: string): AdapterSpec {
  return {
    app: "fake",
    adapterVersion: 1,
    binary: "fake",
    ...(identityEnv ? { identityEnv } : {}),
    models: [{ model: "pinned-id", slug: "fake/pinned" }],
    ...(listModels ? { listModels } : {}),
    invoke: { argv: ["-m", "{slug}"], promptVia: "stdin", extract: { kind: "text" } },
    autonomyFlags: { full: [] },
    defaultAutonomy: "full",
    defaultTimeoutMs: 1000,
    admissionFailurePatterns: [],
  };
}

const LINES: ListModelsSpec = { argv: ["models"], extract: { kind: "lines" } };

describe("parseSlugs", () => {
  test("lines: one slug per non-blank line, junk lines dropped, duplicates collapsed", () => {
    const out = "opencode/big-pickle\n\n  github-copilot/gpt-6-astra  \nnot a slug\nopencode/big-pickle\n";
    expect(parseSlugs({ kind: "lines" }, out)).toEqual({
      slugs: ["opencode/big-pickle", "github-copilot/gpt-6-astra"],
    });
  });

  test("lines with a separator: the text before it, and only on lines that have it", () => {
    const out = "Available models\n\nauto - Auto (default)\ngpt-5.3-codex-low - Codex 5.3 Low\n";
    expect(parseSlugs({ kind: "lines", separator: " - " }, out)).toEqual({
      slugs: ["auto", "gpt-5.3-codex-low"],
    });
  });

  test("json array: the slug path per element, filtered by where", () => {
    const out = JSON.stringify({
      models: [
        { slug: "gpt-6-astra", visibility: "list" },
        { slug: "gpt-reserve", visibility: "hide" },
        { slug: "gpt-5.6-sol", visibility: "list" },
        { visibility: "list" },
      ],
    });
    expect(
      parseSlugs(
        { kind: "json", path: "models", slug: "slug", where: { path: "visibility", equals: "list" } },
        out,
      ),
    ).toEqual({ slugs: ["gpt-6-astra", "gpt-5.6-sol"] });
  });

  test("json array of strings needs no slug path", () => {
    expect(parseSlugs({ kind: "json", path: "ids" }, '{"ids":["a","b",3]}')).toEqual({
      slugs: ["a", "b"],
    });
  });

  test("json object: its keys are the slugs", () => {
    const out = JSON.stringify({
      models: { "kimi-code/k3": { model: "k3" }, "kimi-code/k3-256k": { model: "k3-256k" } },
    });
    expect(parseSlugs({ kind: "json", path: "models" }, out)).toEqual({
      slugs: ["kimi-code/k3", "kimi-code/k3-256k"],
    });
  });

  test("json failures are reported, not turned into an empty catalog", () => {
    expect(parseSlugs({ kind: "json", path: "models" }, "not json")).toEqual({
      error: "listing is not valid JSON",
    });
    expect(parseSlugs({ kind: "json", path: "models" }, '{"models":"k3"}')).toEqual({
      error: 'listing has no array or object at "models"',
    });
  });

  test("a slug is only what a route key can carry", () => {
    const out = 'ok-slug\nhas space\nhas"quote\nhas*glob\nprov/Model-1.0:Q4_K_M\n';
    expect(parseSlugs({ kind: "lines" }, out)).toEqual({ slugs: ["ok-slug", "prov/Model-1.0:Q4_K_M"] });
  });
});

describe("catalogOf", () => {
  test("no listing command, or no binary: the pinned routes are the catalog", async () => {
    expect(await catalogOf(spec(undefined), "/bin/whatever")).toEqual({
      routes: [{ model: "pinned-id", slug: "fake/pinned" }],
    });
    expect(await catalogOf(spec(LINES), null)).toEqual({
      routes: [{ model: "pinned-id", slug: "fake/pinned" }],
    });
  });

  test("reported slugs become routes under their own name, after the pinned ones", async () => {
    const { binary } = fakeLister("fake/new\nfake/pinned\nfake/other");
    expect(await catalogOf(spec(LINES), binary)).toEqual({
      routes: [
        { model: "pinned-id", slug: "fake/pinned" },
        { model: "fake/new", slug: "fake/new" },
        { model: "fake/other", slug: "fake/other" },
      ],
    });
  });

  test("a reported slug never shadows a pinned canonical id", async () => {
    const { binary } = fakeLister("pinned-id\nfake/new");
    expect((await catalogOf(spec(LINES), binary)).routes.map((r) => r.model)).toEqual([
      "pinned-id",
      "fake/new",
    ]);
  });

  test("a failed listing keeps the pinned routes and says why", async () => {
    const { binary } = fakeLister("boom", 3);
    const catalog = await catalogOf(spec(LINES), binary);
    expect(catalog.routes).toEqual([{ model: "pinned-id", slug: "fake/pinned" }]);
    expect(catalog.listingError).toBe("'models' exit 3");
  });

  test("the listing is memoized in memory and on disk", async () => {
    const lister = fakeLister("fake/new");
    await catalogOf(spec(LINES), lister.binary);
    await catalogOf(spec(LINES), lister.binary);
    expect(lister.calls()).toBe(1);
    expect(existsSync(catalogCachePath())).toBe(true);
    expect(catalogCachePath()).toStartWith(cacheHome);
    // A fresh process reads the file instead of listing again.
    forgetCatalogMemory();
    expect((await catalogOf(spec(LINES), lister.binary)).routes.map((r) => r.slug)).toContain("fake/new");
    expect(lister.calls()).toBe(1);
  });

  test("a binary replaced under a live process is asked again", async () => {
    const lister = fakeLister("fake/new");
    await catalogOf(spec(LINES), lister.binary);
    const later = new Date(Date.now() + 5_000);
    utimesSync(lister.binary, later, later);
    await catalogOf(spec(LINES), lister.binary);
    expect(lister.calls()).toBe(2);
  });

  test("the cache is per identity: another config dir is another catalog", async () => {
    const lister = fakeLister("fake/new");
    const withIdentity = spec(LINES, "FAKE_HOME");
    await catalogOf(withIdentity, lister.binary, { ...process.env, FAKE_HOME: "/tmp/one" });
    await catalogOf(withIdentity, lister.binary, { ...process.env, FAKE_HOME: "/tmp/two" });
    expect(lister.calls()).toBe(2);
  });

  test("simultaneous cache misses share a single listing process", async () => {
    const lister = fakeLister("fake/new");
    const catalogs = await Promise.all(Array.from({ length: 12 }, () => catalogOf(spec(LINES), lister.binary)));
    expect(catalogs.every(catalog => catalog.routes.some(route => route.slug === "fake/new"))).toBe(true);
    expect(lister.calls()).toBe(1);
  });

  test("effective account environments select and cache different model rosters", async () => {
    const lister = fakeLister("");
    writeFileSync(lister.binary, '#!/bin/sh\necho "$ACCOUNT_MODEL"\n');
    const inherited = { ...process.env, FAKE_HOME: "/tmp/shared", ACCOUNT_SECRET: "private-credential-do-not-persist" };
    const free = { ...inherited, ACCOUNT_MODEL: "free-model" };
    const paid = { ...inherited, ACCOUNT_MODEL: "paid-model" };
    const adapter = spec(LINES, "FAKE_HOME");
    expect((await catalogOf(adapter, lister.binary, free)).routes.at(-1)?.model).toBe("free-model");
    expect((await catalogOf(adapter, lister.binary, paid)).routes.at(-1)?.model).toBe("paid-model");
    forgetCatalogMemory();
    expect((await catalogOf(adapter, lister.binary, free)).routes.at(-1)?.model).toBe("free-model");
    expect((await catalogOf(adapter, lister.binary, paid)).routes.at(-1)?.model).toBe("paid-model");
    expect(readFileSync(catalogCachePath(), "utf8")).not.toContain(inherited.ACCOUNT_SECRET);
  });

  test("a slow listing observes a timer that ran while the child was active", async () => {
    const lister = fakeLister("");
    const marker = join(cacheHome, "timer-fired");
    writeFileSync(lister.binary, `#!/bin/sh\n/bin/sleep 0.15\nif [ -f '${marker}' ]; then echo timer-ran; else echo timer-blocked; fi\n`);
    const timer = setTimeout(() => writeFileSync(marker, "done"), 20);
    try {
      expect((await catalogOf(spec(LINES), lister.binary)).routes.at(-1)?.slug).toBe("timer-ran");
    } finally {
      clearTimeout(timer);
    }
  });

  test("a version probe that times out cannot cache partial stdout as a version", async () => {
    const lister = fakeLister("");
    // Some CLIs catch termination and exit zero after printing a partial result.
    writeFileSync(lister.binary, "#!/bin/sh\ntrap 'exit 0' TERM\necho partial-version\nwhile :; do /bin/sleep 0.1; done\n");
    expect(await probeVersion(lister.binary)).toBeUndefined();
    // A cached result must retain the failure, too.
    expect(await probeVersion(lister.binary)).toBeUndefined();
  }, 10_000);
});
