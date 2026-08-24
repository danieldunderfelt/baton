import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { builtinAdapters } from "../adapters/builtin/index.ts";
import type { Autonomy } from "../adapters/types.ts";
import { ensurePaths, resolvePaths } from "../config/paths.ts";
import { nowIso, openStore } from "../store/store.ts";
import {
  POLICY_VERSION,
  ceilingFor,
  clampAutonomy,
  detectApps,
  knownModels,
  listModels,
  resolveTargets,
  selectTarget,
} from "./registry.ts";

/** A throwaway BATON_CONFIG_DIR scope. Never touches a real Baton dir. */
function scopeStore(name: string): Database {
  const root = mkdtempSync(join(tmpdir(), `baton-${name}-`));
  const paths = ensurePaths(resolvePaths({ BATON_CONFIG_DIR: root }));
  return openStore(paths.dbPath);
}

/** Availability follows PATH; emptying it is how "app not installed" is faked. */
function withPath<T>(path: string, fn: () => T): T {
  const prev = process.env.PATH;
  process.env.PATH = path;
  try {
    return fn();
  } finally {
    process.env.PATH = prev;
  }
}

const NO_PATH = "/nonexistent-baton-test";

/** A PATH holding exactly one (fake, never executed) binary — hermetic availability. */
function withFakeBinary<T>(name: string, fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "baton-bin-"));
  writeFileSync(join(dir, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return withPath(dir, fn);
}

// codex and kimi are installed on the dev machine; skip the availability-true
// assertions elsewhere rather than pretend.
const codexInstalled = Bun.which("codex") !== null;

describe("detectApps", () => {
  test("reports every builtin app, sorted, without throwing", () => {
    const apps = detectApps({ probeVersion: false });
    expect(apps.map((a) => a.app)).toEqual(["codex", "kimi"]);
    expect(apps.length).toBe(builtinAdapters.length);
  });

  test("missing binaries yield null paths, not errors", () => {
    const apps = withPath(NO_PATH, () => detectApps({ probeVersion: false }));
    expect(apps.every((a) => a.binaryPath === null)).toBe(true);
    expect(apps.every((a) => a.version === undefined)).toBe(true);
  });

  test.if(codexInstalled)("resolves installed binaries to absolute paths", () => {
    const codex = detectApps({ probeVersion: false }).find((a) => a.app === "codex")!;
    expect(codex.binaryPath).toStartWith("/");
  });

  test.if(codexInstalled)("probes a version string when asked", () => {
    const codex = detectApps().find((a) => a.app === "codex")!;
    expect(codex.version).toBeTruthy();
  });
});

describe("resolveTargets", () => {
  test("returns the routes for a canonical model", () => {
    const targets = resolveTargets("kimi-k3");
    expect(targets.map((t) => [t.spec.app, t.slug])).toEqual([["kimi", "kimi-code/k3"]]);
  });

  test("is deterministic and ordered by app", () => {
    for (const model of knownModels()) {
      const apps = resolveTargets(model).map((t) => t.spec.app);
      expect(apps).toEqual([...apps].sort());
      expect(resolveTargets(model)).toEqual(resolveTargets(model));
    }
  });

  test("unknown model errors with the known models listed", () => {
    expect(() => resolveTargets("gpt-9")).toThrow(/Unknown model 'gpt-9'/);
    expect(() => resolveTargets("gpt-9")).toThrow(/kimi-k3/);
  });

  test("ignores availability — routes exist even with an empty PATH", () => {
    expect(withPath(NO_PATH, () => resolveTargets("kimi-k3")).length).toBe(1);
  });
});

describe("selectTarget", () => {
  test("policy v1 picks the first available route and mints a fingerprint", () => {
    const db = scopeStore("select");
    const target = selectTarget(db, "gpt-5.6-sol");
    expect(target.spec.app).toBe("codex");
    expect(target.instance).toBe("default");
    expect(target.targetFingerprint).toBe("codex:default/gpt-5.6-sol@a1");
    expect(POLICY_VERSION).toBe(1);
  });

  test.if(codexInstalled)("carries the verified absolute binary path", () => {
    const db = scopeStore("select-binary");
    const target = selectTarget(db, "gpt-5.6-sol");
    expect(target.binaryPath).toStartWith("/");
    expect(target.binaryPath).toBe(Bun.which("codex")!);
  });

  test("errors when no route's binary is on PATH, naming the app and why", () => {
    const db = scopeStore("unavailable");
    expect(() => withPath(NO_PATH, () => selectTarget(db, "kimi-k3"))).toThrow(
      /No usable route for model 'kimi-k3'.*kimi: binary not found/s,
    );
  });

  test("a ceiling the adapter cannot express excludes the route, explaining why", () => {
    const db = scopeStore("ceiling-excluded");
    // kimi's non-interactive mode has one authority level: 'full'.
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("max_autonomy:kimi", "edits");
    withFakeBinary("kimi", () => {
      expect(() => selectTarget(db, "kimi-k3")).toThrow(
        /kimi: ceiling 'edits' unsupported \(supports: full\)/,
      );
      // The fix command is in the message, not just the diagnosis.
      expect(() => selectTarget(db, "kimi-k3")).toThrow(/baton set max_autonomy:<app>/);
    });
  });

  test("a supported ceiling keeps the route selectable", () => {
    const db = scopeStore("ceiling-ok");
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("max_autonomy:kimi", "full");
    withFakeBinary("kimi", () => {
      expect(selectTarget(db, "kimi-k3").spec.app).toBe("kimi");
    });
  });

  test("rejects an instance the scope does not define", () => {
    const db = scopeStore("badinstance");
    expect(() => selectTarget(db, "kimi-k3", { instance: "personal-2" })).toThrow(
      /Unknown instance 'personal-2' for app 'kimi'/,
    );
  });

  test("accepts a defined instance and puts it in the fingerprint", () => {
    const db = scopeStore("goodinstance");
    db.query("INSERT INTO instances (app, name, env, created_at) VALUES (?, ?, ?, ?)").run(
      "kimi",
      "personal-2",
      JSON.stringify({ KIMI_CODE_HOME: "/tmp/kimi2" }),
      nowIso(),
    );
    const target = selectTarget(db, "kimi-k3", { instance: "personal-2" });
    expect(target.instance).toBe("personal-2");
    expect(target.targetFingerprint).toBe("kimi:personal-2/kimi-code/k3@a1");
  });

  test("instances are scope-local: another scope's DB does not see them", () => {
    const a = scopeStore("scope-a");
    const b = scopeStore("scope-b");
    a.query("INSERT INTO instances (app, name, env, created_at) VALUES (?, ?, ?, ?)").run(
      "kimi",
      "personal-2",
      "{}",
      nowIso(),
    );
    expect(selectTarget(a, "kimi-k3", { instance: "personal-2" }).instance).toBe("personal-2");
    expect(() => selectTarget(b, "kimi-k3", { instance: "personal-2" })).toThrow(
      /Known instances: default/,
    );
  });

  test("unknown model errors before anything else", () => {
    const db = scopeStore("unknown");
    expect(() => selectTarget(db, "nope")).toThrow(/Unknown model 'nope'/);
  });
});

describe("ceilingFor / clampAutonomy", () => {
  test("defaults to full and reads the per-app setting", () => {
    const db = scopeStore("ceiling");
    expect(ceilingFor(db, "codex")).toBe("full");
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("max_autonomy:codex", "edits");
    expect(ceilingFor(db, "codex")).toBe("edits");
    expect(ceilingFor(db, "kimi")).toBe("full");
  });

  test("a garbage setting value falls back to the default", () => {
    const db = scopeStore("ceiling-garbage");
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("max_autonomy:codex", "yolo");
    expect(ceilingFor(db, "codex")).toBe("full");
  });

  test("clamp truth table: min(requested ?? specDefault, ceiling)", () => {
    const cases: [Autonomy | undefined, Autonomy, Autonomy, Autonomy][] = [
      ["full", "full", "full", "full"],
      ["full", "edits", "full", "edits"],
      ["full", "readonly", "full", "readonly"],
      ["edits", "full", "full", "edits"],
      ["edits", "readonly", "full", "readonly"],
      ["readonly", "full", "full", "readonly"],
      ["readonly", "edits", "readonly", "readonly"],
      [undefined, "full", "full", "full"],
      [undefined, "full", "edits", "edits"],
      [undefined, "edits", "full", "edits"],
      [undefined, "readonly", "edits", "readonly"],
    ];
    for (const [requested, ceiling, specDefault, expected] of cases) {
      const got = clampAutonomy(requested, ceiling, specDefault);
      expect([requested, ceiling, specDefault, got]).toEqual([
        requested,
        ceiling,
        specDefault,
        expected,
      ]);
    }
  });
});

describe("listModels", () => {
  test("lists every builtin route, sorted by model then app", () => {
    const db = scopeStore("list");
    const rows = listModels(db);
    const routeCount = builtinAdapters.reduce((n, a) => n + a.models.length, 0);
    expect(rows.length).toBe(routeCount);
    expect(rows.map((r) => `${r.model}|${r.app}`)).toEqual(
      [...rows.map((r) => `${r.model}|${r.app}`)].sort(),
    );
    expect(rows.every((r) => r.instance === "default" && r.rating === "unrated")).toBe(true);
  });

  test("availability tracks PATH, with the reason spelled out", () => {
    const db = scopeStore("list-path");
    const rows = withPath(NO_PATH, () => listModels(db));
    expect(rows.every((r) => !r.available)).toBe(true);
    expect(rows.every((r) => r.degradedReason === "binary not found")).toBe(true);
  });

  test("an unsupported ceiling degrades the route instead of hiding the problem", () => {
    const db = scopeStore("list-degraded");
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("max_autonomy:kimi", "edits");
    const kimi = withFakeBinary("kimi", () => listModels(db)).find((r) => r.app === "kimi")!;
    expect(kimi.available).toBe(false);
    expect(kimi.degradedReason).toBe("ceiling 'edits' unsupported (supports: full)");
  });

  test.if(codexInstalled)("installed apps are marked available", () => {
    const db = scopeStore("list-available");
    expect(listModels(db).filter((r) => r.app === "codex").every((r) => r.available)).toBe(true);
  });

  test("maxAutonomy reflects the per-app ceiling", () => {
    const db = scopeStore("list-ceiling");
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      "max_autonomy:kimi",
      "readonly",
    );
    const rows = listModels(db);
    expect(rows.find((r) => r.app === "kimi")!.maxAutonomy).toBe("readonly");
    expect(rows.find((r) => r.app === "codex")!.maxAutonomy).toBe("full");
  });
});
