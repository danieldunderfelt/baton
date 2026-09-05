import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ensurePaths, resolvePaths } from "../config/paths.ts";
import { setPool } from "../quota/pools.ts";
import { nowIso, openStore } from "../store/store.ts";
import {
  addBlock,
  blockFor,
  blockReason,
  canarySlug,
  listBlocks,
  normalizePattern,
  removeBlock,
  routeKey,
} from "./blocks.ts";
import { listModels, selectTarget, targetFor } from "./registry.ts";

function scopeStore(name: string): Database {
  const root = mkdtempSync(join(tmpdir(), `baton-${name}-`));
  const paths = ensurePaths(resolvePaths({ BATON_CONFIG_DIR: root }));
  return openStore(paths.dbPath);
}

/**
 * A route opencode reports rather than one Baton pins: blocks address what the
 * app serves right now, and a reported slug is the common case.
 */
const REPORTED = "fake-provider/fake-model";

/**
 * A PATH holding one fake binary, so availability is hermetic. It answers the
 * version probe; opencode's fake also reports REPORTED as its one listed model.
 */
function fakeBinary(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "baton-bin-"));
  const listing = name === "opencode" ? ` models) echo ${REPORTED}; exit 0;;` : "";
  writeFileSync(
    join(dir, name),
    `#!/bin/sh\ncase "$1" in --version) echo 9.9.9; exit 0;;${listing} esac\nexit 1\n`,
    { mode: 0o755 },
  );
  return join(dir, name);
}

function withFakeBinary<T>(name: string, fn: () => T): T {
  const prev = process.env.PATH;
  process.env.PATH = dirname(fakeBinary(name));
  try {
    return fn();
  } finally {
    process.env.PATH = prev;
  }
}

describe("normalizePattern", () => {
  test("a bare app blocks every route of it, on every instance", () => {
    expect(normalizePattern("opencode")).toBe("opencode:*/*");
  });

  test("an omitted instance means every instance", () => {
    expect(normalizePattern("opencode/github-copilot/*")).toBe("opencode:*/github-copilot/*");
  });

  test("an explicit instance is kept", () => {
    expect(normalizePattern("codex:work/*")).toBe("codex:work/*");
    expect(normalizePattern("codex:work")).toBe("codex:work/*");
  });

  test("slugs keep their slashes — only the first one splits", () => {
    expect(normalizePattern(`opencode/${REPORTED}`)).toBe(`opencode:*/${REPORTED}`);
  });

  test("refuses patterns that cannot match anything real", () => {
    expect(() => normalizePattern("")).toThrow(/cannot be empty/);
    expect(() => normalizePattern("  ")).toThrow(/cannot be empty/);
    expect(() => normalizePattern("/slug")).toThrow(/names no app/);
    expect(() => normalizePattern("opencode/")).toThrow(/names no slug/);
    expect(() => normalizePattern("open code/*")).toThrow(/Invalid block pattern/);
    expect(() => normalizePattern("opencode/$(rm -rf)")).toThrow(/Invalid block pattern/);
  });
});

describe("blockFor", () => {
  const blocks = [
    { pattern: normalizePattern("opencode/fake-provider/*"), createdAt: nowIso() },
    { pattern: normalizePattern("codex:work/*"), createdAt: nowIso() },
  ];

  test("matches the routes the pattern covers", () => {
    expect(blockFor(blocks, "opencode", "default", REPORTED)?.pattern).toBe(
      "opencode:*/fake-provider/*",
    );
  });

  test("leaves the app's other providers alone", () => {
    expect(blockFor(blocks, "opencode", "default", "opencode/x-preview-f-free")).toBeUndefined();
  });

  test("an instance-scoped block only covers that instance", () => {
    expect(blockFor(blocks, "codex", "work", "gpt-5.6-sol")).toBeDefined();
    expect(blockFor(blocks, "codex", "default", "gpt-5.6-sol")).toBeUndefined();
  });

  test("a glob is never a regex — dots and plusses are literal", () => {
    const literal = [{ pattern: normalizePattern("opencode/a.b+c"), createdAt: nowIso() }];
    expect(blockFor(literal, "opencode", "default", "a.b+c")).toBeDefined();
    expect(blockFor(literal, "opencode", "default", "axbxc")).toBeUndefined();
  });

  test("the reason is carried into how the refusal reads", () => {
    const one = [{ pattern: "opencode:*/*", reason: "client subscription", createdAt: nowIso() }];
    expect(blockReason(one[0]!)).toBe("blocked by 'opencode:*/*' (client subscription)");
  });

  test("routeKey is the fingerprint's own prefix", () => {
    expect(routeKey("opencode", "default", REPORTED)).toBe(
      `opencode:default/${REPORTED}`,
    );
  });
});

describe("the block store", () => {
  test("add is idempotent and normalizes; remove takes either form", () => {
    const db = scopeStore("blocks-store");
    addBlock(db, "opencode/github-copilot/*", "client enterprise subscription");
    addBlock(db, "opencode:*/github-copilot/*", "client enterprise subscription, still");

    const blocks = listBlocks(db);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.pattern).toBe("opencode:*/github-copilot/*");
    expect(blocks[0]!.reason).toBe("client enterprise subscription, still");

    expect(removeBlock(db, "opencode/github-copilot/*")).toBe(true);
    expect(removeBlock(db, "opencode/github-copilot/*")).toBe(false);
    expect(listBlocks(db)).toEqual([]);
  });

  test("a block with no reason stays reasonless", () => {
    const db = scopeStore("blocks-noreason");
    addBlock(db, "opencode");
    expect(listBlocks(db)[0]).toMatchObject({ pattern: "opencode:*/*" });
    expect(listBlocks(db)[0]!.reason).toBeUndefined();
  });
});

describe("selection", () => {
  test("a blocked route is excluded, and never relaxed onto", () => {
    const db = scopeStore("blocks-select");
    addBlock(db, "opencode/fake-provider/*", "client enterprise subscription");
    expect(() => withFakeBinary("opencode", () => selectTarget(db, REPORTED))).toThrow(
      /client enterprise subscription/,
    );
  });

  test("the refusal does not advise waiting for quota that would never free it", () => {
    const db = scopeStore("blocks-select-hint");
    addBlock(db, "opencode");
    let error = "";
    try {
      withFakeBinary("opencode", () => selectTarget(db, "ox-alpha"));
    } catch (err) {
      error = (err as Error).message;
    }
    expect(error).toMatch(/deny list/);
    expect(error).not.toMatch(/wait for a cooldown/);
  });

  test("the app's unblocked routes still route", () => {
    const db = scopeStore("blocks-select-sibling");
    addBlock(db, "opencode/fake-provider/*");
    const target = withFakeBinary("opencode", () => selectTarget(db, "ox-alpha"));
    expect(target.slug).toBe("opencode/x-preview-f-free");
  });

  test("blocking one instance leaves the pool's others selectable", () => {
    const db = scopeStore("blocks-select-pool");
    for (const name of ["work", "personal"]) {
      db.query("INSERT INTO instances (app, name, env, created_at) VALUES (?, ?, '{}', ?)").run(
        "kimi",
        name,
        nowIso(),
      );
    }
    setPool(db, "kimi", ["work", "personal"]);
    addBlock(db, "kimi:work/*", "client machine");

    const target = withFakeBinary("kimi", () => selectTarget(db, "kimi-k3"));
    expect(target.instance).toBe("personal");
    expect(target.considered?.find((c) => c.instance === "work")?.excluded).toMatch(
      /client machine/,
    );
  });
});

describe("resume", () => {
  test("session affinity does not outrank a block added since", () => {
    const db = scopeStore("blocks-resume");
    addBlock(db, "opencode/fake-provider/*", "client enterprise subscription");
    const ref = { app: "opencode", slug: REPORTED, instance: "default" };
    expect(() => withFakeBinary("opencode", () => targetFor(ref, db))).toThrow(
      /Cannot resume this run.*client enterprise subscription/s,
    );
  });

  test("an unblocked route of the same app still resumes", () => {
    const db = scopeStore("blocks-resume-sibling");
    addBlock(db, "opencode/fake-provider/*");
    const ref = { app: "opencode", slug: "opencode/x-preview-f-free", instance: "default" };
    expect(withFakeBinary("opencode", () => targetFor(ref, db)).slug).toBe(
      "opencode/x-preview-f-free",
    );
  });
});

describe("list_models", () => {
  test("a fully blocked route is unavailable, with the pattern and reason", () => {
    const db = scopeStore("blocks-list");
    addBlock(db, "opencode/fake-provider/*", "client enterprise subscription");
    const row = withFakeBinary("opencode", () => listModels(db)).find((m) => m.model === REPORTED)!;
    expect(row.available).toBe(false);
    expect(row.degradedReason).toBe(
      "blocked by 'opencode:*/fake-provider/*' (client enterprise subscription)",
    );
  });

  test("the app's other routes are unaffected", () => {
    const db = scopeStore("blocks-list-sibling");
    addBlock(db, "opencode/fake-provider/*");
    const row = withFakeBinary("opencode", () => listModels(db)).find((m) => m.model === "ox-alpha")!;
    expect(row.available).toBe(true);
    expect(row.degradedReason).toBeUndefined();
  });

  test("a partial block does not claim the route is unavailable", () => {
    const db = scopeStore("blocks-list-partial");
    for (const name of ["work", "personal"]) {
      db.query("INSERT INTO instances (app, name, env, created_at) VALUES (?, ?, '{}', ?)").run(
        "kimi",
        name,
        nowIso(),
      );
    }
    setPool(db, "kimi", ["work", "personal"]);
    addBlock(db, "kimi:work/*");
    const row = withFakeBinary("kimi", () => listModels(db)).find((m) => m.model === "kimi-k3")!;
    expect(row.available).toBe(true);
  });
});

describe("canarySlug", () => {
  const models = [
    { model: "ox-alpha", slug: "opencode/x-preview-f-free" },
    { model: REPORTED, slug: REPORTED },
  ];

  test("picks the first route the user has not blocked", () => {
    const blocks = [{ pattern: normalizePattern("opencode/opencode/*"), createdAt: nowIso() }];
    expect(canarySlug(blocks, "opencode", models, "default")).toEqual({ slug: REPORTED });
  });

  test("refuses when every route is blocked", () => {
    const blocks = [{ pattern: "opencode:*/*", reason: "client", createdAt: nowIso() }];
    const result = canarySlug(blocks, "opencode", models, "default");
    expect(result && "blocked" in result && result.blocked.reason).toBe("client");
  });

  test("no routes at all is not a block", () => {
    expect(canarySlug([], "opencode", [], "default")).toBeUndefined();
  });
});
