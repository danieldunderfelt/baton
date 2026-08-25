import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { builtinAdapters } from "../adapters/builtin/index.ts";
import type { Autonomy } from "../adapters/types.ts";
import { ensurePaths, resolvePaths } from "../config/paths.ts";
import { submitSpec } from "../discovery/discovery.ts";
import { recordGrade, seedPriors } from "../eval/evalStore.ts";
import { preciousnessKey, setPool } from "../quota/pools.ts";
import { recordAdmissionFailure, recordRun } from "../quota/quota.ts";
import { newId, nowIso, openStore } from "../store/store.ts";
import {
  DEFAULT_INSTANCE,
  POLICY_VERSION,
  candidateKey,
  ceilingFor,
  clampAutonomy,
  detectApps,
  knownModels,
  listModels,
  resolveTargets,
  selectTarget,
  targetFor,
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

/**
 * A PATH holding exactly one fake binary — hermetic availability. The script
 * answers `--version` because the app version is part of the execution-target
 * fingerprint; nothing else about it is ever executed.
 */
const FAKE_VERSION = "9.9.9";

function fakeBinary(name: string, version = FAKE_VERSION): string {
  const dir = mkdtempSync(join(tmpdir(), "baton-bin-"));
  writeFileSync(join(dir, name), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  return join(dir, name);
}

function withFakeBinary<T>(name: string, fn: () => T): T {
  return withPath(dirname(fakeBinary(name)), fn);
}

// codex and kimi are installed on the dev machine; skip the availability-true
// assertions elsewhere rather than pretend.
const codexInstalled = Bun.which("codex") !== null;

/** Fixed selection time, so quota windows and cooldowns are deterministic. */
const NOW = "2026-08-24T12:00:00.000Z";
const at = (offsetMs: number): string => new Date(Date.parse(NOW) + offsetMs).toISOString();

/** A kimi pool over `members`, each a real instance in this scope. */
function pooled(db: Database, members: string[]): void {
  for (const name of members) {
    db.query("INSERT INTO instances (app, name, env, created_at) VALUES (?, ?, '{}', ?)").run(
      "kimi",
      name,
      nowIso(),
    );
  }
  setPool(db, "kimi", members);
}

function setting(db: Database, key: string, value: string): void {
  db.query(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

describe("detectApps", () => {
  test("reports every builtin app, sorted, without throwing", () => {
    const apps = detectApps({ probeVersion: false });
    expect(apps.map((a) => a.app)).toEqual([...builtinAdapters.map((a) => a.app)].sort());
    expect(apps).toContainEqual(expect.objectContaining({ app: "codex" }));
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

/**
 * Discovered adapters are the same format as built-ins, but only an ACTIVE one
 * (reviewed, approved, canaried) is merged into the registry — PLAN.md
 * §Agentic discovery: approval precedes execution, and routing IS execution.
 */
describe("discovered adapters in the registry", () => {
  const DISCOVERED_STATUSES = ["quarantined", "approved", "stale", "rejected"] as const;

  /** Submits a spec for `model`, and forces it to `status` as review would. */
  function discovered(
    db: Database,
    opts: { model: string; status?: string; binary?: string; app?: string } = { model: "demo-1" },
  ): { app: string; binary: string } {
    const app = opts.app ?? "demo";
    const binary = opts.binary ?? fakeBinary(app);
    const stored = submitSpec(db, {
      app,
      adapterVersion: 3,
      binary,
      models: [{ model: opts.model, slug: "demo/one" }],
      invoke: {
        argv: ["run", "--model", "{slug}"],
        promptVia: "stdin",
        extract: { kind: "text" },
      },
      autonomyFlags: { full: ["--dangerously"] },
      defaultAutonomy: "full",
      defaultTimeoutMs: 60_000,
      admissionFailurePatterns: ["rate limit"],
    });
    expect(stored).toMatchObject({ ok: true });
    if (opts.status && opts.status !== "quarantined") {
      db.query("UPDATE discovered_adapters SET status = ? WHERE app = ?").run(opts.status, app);
    }
    return { app, binary };
  }

  test("an active adapter routes like a builtin, from its reviewed absolute path", () => {
    const db = scopeStore("discovered-active");
    const { binary } = discovered(db, { model: "demo-1", status: "active" });

    // Empty PATH: nothing here was found by name — the approved path is spawned.
    const target = withPath(NO_PATH, () => selectTarget(db, "demo-1"));
    expect(target.spec.app).toBe("demo");
    expect(target.binaryPath).toBe(binary);
    expect(target.instance).toBe("default");
    expect(target.targetFingerprint).toBe(`demo:default/demo/one@a3+v${FAKE_VERSION}`);
    expect(resolveTargets("demo-1", db).map((r) => r.slug)).toEqual(["demo/one"]);
    expect(knownModels(db)).toContain("demo-1");
  });

  test("a discovered route carries a model whose builtin is unavailable", () => {
    const db = scopeStore("discovered-failover");
    discovered(db, { model: "kimi-k3", status: "active" });
    // kimi's own binary is off PATH; the discovered app still reaches the model.
    expect(withPath(NO_PATH, () => selectTarget(db, "kimi-k3")).spec.app).toBe("demo");
  });

  test("nothing but an active adapter routes — that is the quarantine gate", () => {
    for (const status of DISCOVERED_STATUSES) {
      const db = scopeStore(`discovered-${status}`);
      discovered(db, { model: "demo-1", status });
      expect(() => selectTarget(db, "demo-1")).toThrow(/Unknown model 'demo-1'/);
      expect(() => resolveTargets("demo-1", db)).toThrow(/Unknown model 'demo-1'/);
      expect(knownModels(db)).not.toContain("demo-1");
    }
  });

  test("listModels shows a quarantined adapter as degraded, never as available", () => {
    const db = scopeStore("discovered-listed");
    discovered(db, { model: "demo-1" });
    const row = listModels(db).find((r) => r.model === "demo-1")!;
    expect(row.available).toBe(false);
    expect(row.degradedReason).toContain("quarantined — awaiting review");
    expect(row.degradedReason).toContain("baton adapters review demo");

    // A rejected adapter is a decision, not a hint: it drops out of the listing.
    db.query("UPDATE discovered_adapters SET status = 'rejected' WHERE app = 'demo'").run();
    expect(listModels(db).find((r) => r.model === "demo-1")).toBeUndefined();
  });

  test("an active adapter is listed available, with its own pool suppressed", () => {
    const db = scopeStore("discovered-listed-active");
    discovered(db, { model: "demo-1", status: "active" });
    const row = listModels(db).find((r) => r.model === "demo-1")!;
    expect(row).toMatchObject({ app: "demo", available: true, instance: "default" });
    expect(row.degradedReason).toBeUndefined();
    // No identityEnv: every "instance" would be the same account, so no pool.
    db.query("INSERT INTO pools (app, members, created_at) VALUES ('demo', ?, ?)").run(
      JSON.stringify(["default", "other"]),
      nowIso(),
    );
    expect(listModels(db).find((r) => r.model === "demo-1")!.pool).toBeUndefined();
    expect(selectTarget(db, "demo-1").considered).toHaveLength(1);
  });
});

describe("selectTarget", () => {
  test("policy v2 picks an available route on the default instance", () => {
    const db = scopeStore("select");
    const target = withFakeBinary("codex", () => selectTarget(db, "gpt-5.6-sol"));
    expect(target.spec.app).toBe("codex");
    expect(target.instance).toBe("default");
    expect(target.targetFingerprint).toBe(`codex:default/gpt-5.6-sol@a1+v${FAKE_VERSION}`);
    // No pool: the sole candidate is the inherited environment, at full headroom.
    expect(target.considered).toEqual([
      {
        app: "codex",
        slug: "gpt-5.6-sol",
        instance: "default",
        quota: 1,
        rating: 1,
        headroom: 1,
        preciousness: "burn",
        chosen: true,
      },
    ]);
    expect(POLICY_VERSION).toBe(2);
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
    expect(() => withFakeBinary("kimi", () => selectTarget(db, "kimi-k3", { instance: "p2" }))).toThrow(
      /unknown instance 'p2' in this scope \(known instances: default\)/,
    );
    // The fix command is in the message, not just the diagnosis.
    expect(() => withFakeBinary("kimi", () => selectTarget(db, "kimi-k3", { instance: "p2" }))).toThrow(
      /baton instance add kimi p2 --env/,
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
    const target = withFakeBinary("kimi", () =>
      selectTarget(db, "kimi-k3", { instance: "personal-2" }),
    );
    expect(target.instance).toBe("personal-2");
    expect(target.targetFingerprint).toBe(`kimi:personal-2/kimi-code/k3@a1+v${FAKE_VERSION}`);
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
    withFakeBinary("kimi", () => {
      expect(selectTarget(a, "kimi-k3", { instance: "personal-2" }).instance).toBe("personal-2");
      expect(() => selectTarget(b, "kimi-k3", { instance: "personal-2" })).toThrow(
        /known instances: default/,
      );
    });
  });

  test("unknown model errors before anything else", () => {
    const db = scopeStore("unknown");
    expect(() => selectTarget(db, "nope")).toThrow(/Unknown model 'nope'/);
  });

  test("the fingerprint carries the app version, as one sanitised segment", () => {
    const db = scopeStore("fingerprint-version");
    const bin = fakeBinary("codex", "codex-cli 0.42.0");
    const target = withPath(dirname(bin), () => selectTarget(db, "gpt-5.6-sol"));
    // The same adapter against another build of the app is not interchangeable
    // evidence, so the version is part of the execution-target identity — and
    // it may not smuggle a '+' or a space into the fingerprint's grammar.
    expect(target.targetFingerprint).toBe("codex:default/gpt-5.6-sol@a1+vcodex-cli-0.42.0");
  });

  test("a binary replaced under a live process is re-probed, not served from cache", () => {
    const db = scopeStore("fingerprint-upgrade");
    const bin = fakeBinary("codex", "codex-cli 0.42.0");
    const ref = { app: "codex", slug: "gpt-5.6-sol", instance: DEFAULT_INSTANCE };
    const before = withPath(dirname(bin), () => targetFor(ref, db));
    expect(before.targetFingerprint).toEndWith("+vcodex-cli-0.42.0");

    // An upgrade lands at the same path while a daemon is running. Memoizing
    // the probe for the life of the process would file this run's evidence
    // against a build that no longer exists.
    writeFileSync(bin, "#!/bin/sh\necho codex-cli 0.43.0-rc1\n", { mode: 0o755 });
    const after = withPath(dirname(bin), () => targetFor(ref, db));
    expect(after.targetFingerprint).toEndWith("+vcodex-cli-0.43.0-rc1");
  });

  test("an app that will not answer --version is 'unknown', not a failure", () => {
    const db = scopeStore("fingerprint-unversioned");
    const dir = mkdtempSync(join(tmpdir(), "baton-bin-"));
    writeFileSync(join(dir, "codex"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    const target = withPath(dir, () => selectTarget(db, "gpt-5.6-sol"));
    expect(target.targetFingerprint).toBe("codex:default/gpt-5.6-sol@a1+vunknown");
  });
});

describe("selectTarget: pool ranking (policy v2)", () => {
  /** Selection over a kimi pool at the fixed NOW, with kimi the only binary. */
  function pick(db: Database, opts: Parameters<typeof selectTarget>[2] = {}) {
    return withFakeBinary("kimi", () => selectTarget(db, "kimi-k3", { nowIso: NOW, ...opts }));
  }

  test("spreads onto the member with more quota headroom", () => {
    const db = scopeStore("pool-spread");
    pooled(db, ["a", "b"]);
    for (let i = 0; i < 4; i++) recordRun(db, "kimi", "a", at(-60_000 * (i + 1)));

    const target = pick(db);
    expect(target.instance).toBe("b");
    const quotas = Object.fromEntries(target.considered!.map((c) => [c.instance, c.quota]));
    expect(quotas.b).toBeGreaterThan(quotas.a!);
    // Nothing was hidden: the loser is reported with its own headroom.
    expect(target.considered!.find((c) => c.instance === "a")!.headroom).toBeLessThan(1);
  });

  test("equal weights break by pool member order, not by name", () => {
    const db = scopeStore("pool-order");
    pooled(db, ["b", "a"]);
    const target = pick(db);
    expect(target.instance).toBe("b");
    expect(target.considered!.map((c) => c.instance)).toEqual(["b", "a"]);
  });

  test("preciousness discounts a member without excluding it", () => {
    const db = scopeStore("pool-conserve");
    pooled(db, ["a", "b"]);
    setting(db, preciousnessKey("kimi", "a"), "conserve");
    const target = pick(db);
    expect(target.instance).toBe("b");
    expect(target.considered!.find((c) => c.instance === "a")!.quota).toBe(0.5);
  });

  test("a cooling member is skipped and the reason is reported", () => {
    const db = scopeStore("pool-cooling");
    pooled(db, ["a", "b"]);
    const until = recordAdmissionFailure(db, "kimi", "a", NOW, "rate limited");

    const target = pick(db);
    expect(target.instance).toBe("b");
    const a = target.considered!.find((c) => c.instance === "a")!;
    expect(a.coolingUntil).toBe(until);
    expect(a.excluded).toContain("cooling down until");
    expect(target.considered!.find((c) => c.instance === "b")!.excluded).toBeUndefined();
  });

  test("an expired cooldown stops excluding the member", () => {
    const db = scopeStore("pool-cooled-off");
    pooled(db, ["a", "b"]);
    recordAdmissionFailure(db, "kimi", "a", at(-60 * 60 * 1000));
    // Same instant, a: cooling. An hour later the 5-minute backoff is spent.
    expect(pick(db, { nowIso: at(-60 * 60 * 1000) }).instance).toBe("b");
    expect(pick(db).instance).toBe("a");
  });

  test("emergency members are last resort: used only when nothing else is", () => {
    const db = scopeStore("pool-emergency");
    pooled(db, ["a", "b"]);
    setting(db, preciousnessKey("kimi", "a"), "emergency");
    expect(pick(db).instance).toBe("b");

    recordAdmissionFailure(db, "kimi", "b", NOW);
    // Relaxation order: spend the emergency account before disturbing a cooldown.
    const relaxed = pick(db);
    expect(relaxed.instance).toBe("a");
    expect(relaxed.considered!.find((c) => c.chosen)!.excluded).toContain("last resort");
  });

  test("when every member is cooling, selection fails with the earliest retry", () => {
    const db = scopeStore("pool-all-cooling");
    pooled(db, ["a", "b"]);
    recordAdmissionFailure(db, "kimi", "a", NOW, undefined, at(60 * 60 * 1000));
    const soonest = at(10 * 60 * 1000);
    recordAdmissionFailure(db, "kimi", "b", NOW, undefined, soonest);

    // Running a still-cooling instance buys another refusal and a longer
    // backoff; the caller is told when to come back instead.
    expect(() => pick(db)).toThrow(/All instances cooling; earliest retry \d\d:\d\d/);
    expect(() => pick(db)).toThrow(soonest);
    // Nothing was spent proving it: no new admission failure was recorded.
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM quota_events").get()!.n,
    ).toBe(2);
  });

  test("a cooling member is never the last resort, but an emergency one still is", () => {
    const db = scopeStore("pool-cooling-vs-emergency");
    pooled(db, ["a", "spare"]);
    setting(db, preciousnessKey("kimi", "spare"), "emergency");
    recordAdmissionFailure(db, "kimi", "a", NOW);

    const target = pick(db);
    expect(target.instance).toBe("spare");
    expect(target.considered!.find((c) => c.chosen)!.excluded).toContain("last resort");
  });

  test("excluded candidates are never re-selected, and exhaustion says so", () => {
    const db = scopeStore("pool-exclude");
    pooled(db, ["a", "b"]);
    expect(pick(db, { exclude: [candidateKey("kimi", "a")] }).instance).toBe("b");
    expect(() =>
      pick(db, { exclude: [candidateKey("kimi", "a"), candidateKey("kimi", "b")] }),
    ).toThrow(/already attempted by this run.*Every pool candidate is spent/s);
  });

  test("a pool member with no instance definition fails closed", () => {
    const db = scopeStore("pool-dangling");
    pooled(db, ["a", "b"]);
    db.query("DELETE FROM instances WHERE app = 'kimi' AND name = 'a'").run();

    // Running it would apply an empty overlay — the inherited account under a
    // second name — so it is refused, and the healthy member carries the run.
    const target = pick(db);
    expect(target.instance).toBe("b");
    expect(target.considered!.find((c) => c.instance === "a")!.excluded).toContain(
      "no instance definition",
    );

    db.query("DELETE FROM instances WHERE app = 'kimi' AND name = 'b'").run();
    expect(() => pick(db)).toThrow(/no instance definition in this scope/);
  });

  test("an explicit instance outranks the pool", () => {
    const db = scopeStore("pool-explicit");
    pooled(db, ["a", "b"]);
    for (let i = 0; i < 9; i++) recordRun(db, "kimi", "a", at(-60_000 * (i + 1)));
    const target = pick(db, { instance: "a" });
    expect(target.instance).toBe("a");
    expect(target.considered).toHaveLength(1);
  });

  /** Graded evidence against one member's execution target (grades.run_id is a real FK). */
  function graded(
    db: Database,
    instance: string,
    grade: number,
    opts: { category?: string; autonomy?: string } = {},
  ): void {
    const runId = newId("run");
    db.query(
      `INSERT INTO runs (id, model, app, slug, instance, prompt, cwd, status, created_at, updated_at)
       VALUES (?, 'kimi-k3', 'kimi', 'kimi-code/k3', ?, 'hi', '/tmp', 'succeeded', ?, ?)`,
    ).run(runId, instance, NOW, NOW);
    recordGrade(db, {
      runId,
      grade,
      target: `kimi:${instance}/kimi-code/k3@a1+v${FAKE_VERSION}+${opts.autonomy ?? "full"}`,
      model: "kimi-k3",
      ...(opts.category === undefined ? {} : { category: opts.category }),
      runAt: NOW,
      gradedAt: NOW,
    });
  }

  test("evidence is per execution target: the better-graded member wins", () => {
    const db = scopeStore("pool-target-rating");
    pooled(db, ["a", "b"]);
    // Untouched, the two are indistinguishable and member order decides.
    expect(pick(db).instance).toBe("a");

    graded(db, "a", 1);
    graded(db, "b", 5);
    const target = pick(db);
    expect(target.instance).toBe("b");
    const ratings = Object.fromEntries(target.considered!.map((c) => [c.instance, c.rating]));
    expect(ratings.b).toBeGreaterThan(ratings.a!);
    // Both are still shrunk toward the model's rollup, so one bad run does not
    // banish a member: the discount stays inside the rating band.
    expect(ratings.a).toBeGreaterThan(0.6);
    // Quota is untouched by any of it: the two stages stay separate.
    expect(target.considered!.every((c) => c.quota === 1)).toBe(true);
  });

  test("thin same-autonomy evidence falls back to the level-pooled rating", () => {
    const db = scopeStore("pool-target-autonomy");
    pooled(db, ["a", "b"]);
    graded(db, "a", 1, { autonomy: "readonly" });
    graded(db, "b", 5, { autonomy: "full" });
    // One graded run at 'full' is thinner than the prior it would be shrunk
    // against, so the level-pooled evidence — which includes it — decides.
    expect(pick(db).instance).toBe("b");
  });

  test("the lens reads evidence at the autonomy the run would actually use", () => {
    const db = scopeStore("pool-autonomy-lens");
    pooled(db, ["a", "b"]);
    // Each member is good at one authority level and bad at the other, with
    // enough runs at each that the same-level evidence stands on its own.
    for (let i = 0; i < 6; i++) {
      graded(db, "a", 5, { autonomy: "full" });
      graded(db, "b", 1, { autonomy: "full" });
      graded(db, "a", 1, { autonomy: "readonly" });
      graded(db, "b", 5, { autonomy: "readonly" });
    }
    // Pooled, the two are identical; only the autonomy lens can tell them apart.
    expect(pick(db, { autonomy: "full" }).instance).toBe("a");
    expect(pick(db, { autonomy: "readonly" }).instance).toBe("b");
    // The resolved default is 'full' for kimi: no explicit request, same answer.
    expect(pick(db).instance).toBe("a");
  });


  test("per-category evidence steers only the category it was graded in", () => {
    const db = scopeStore("pool-category-rating");
    pooled(db, ["a", "b"]);
    graded(db, "a", 1, { category: "review" });
    graded(db, "b", 5, { category: "review" });

    expect(pick(db, { category: "review" }).instance).toBe("b");
    // Uncategorised work has no evidence of its own: back to member order.
    expect(pick(db).instance).toBe("a");
  });

  test("the rating factor is reported separately, and unrated models are not starved", () => {
    const db = scopeStore("pool-rating");
    pooled(db, ["a"]);
    expect(pick(db).considered![0]!.rating).toBe(1);

    seedPriors(db, "onboarding", [{ model: "kimi-k3", mean: 1 }]);
    expect(pick(db).considered![0]!.rating).toBeCloseTo(0.6, 10);

    seedPriors(db, "onboarding", [{ model: "kimi-k3", mean: 5 }]);
    expect(pick(db).considered![0]!.rating).toBeCloseTo(1, 10);
  });

  test("staged ranking: clearly more headroom beats a better rating", () => {
    const db = scopeStore("pool-staged-quota");
    pooled(db, ["a", "b"]);
    for (let i = 0; i < 3; i++) {
      graded(db, "a", 5);
      graded(db, "b", 1);
    }
    // Three recent runs on a: the quota gap is far wider than the ranking grid.
    for (let i = 0; i < 3; i++) recordRun(db, "kimi", "a", at(-60_000 * (i + 1)));

    const target = pick(db);
    const c = Object.fromEntries(target.considered!.map((x) => [x.instance, x]));
    expect(c.a!.quota).toBeLessThan(c.b!.quota);
    // Multiplying the two stages together would send this run to a
    // (0.85 × 0.875 = 0.744 beats 1 × 0.725); staged ranking sends it to the
    // account that still has room, and lets the rating matter next time.
    expect(c.a!.quota * c.a!.rating).toBeGreaterThan(c.b!.quota * c.b!.rating);
    expect(target.instance).toBe("b");
  });

  test("staged ranking: near-equal headroom lets the rating decide", () => {
    const db = scopeStore("pool-staged-rating");
    pooled(db, ["a", "b"]);
    graded(db, "a", 5);
    graded(db, "b", 1);
    // Week-old runs only: b has strictly more headroom than a, but the two
    // land in the same grid cell, so the difference is noise and rating rules.
    recordRun(db, "kimi", "a", at(-24 * 60 * 60 * 1000));
    recordRun(db, "kimi", "a", at(-25 * 60 * 60 * 1000));
    recordRun(db, "kimi", "b", at(-24 * 60 * 60 * 1000));

    const target = pick(db);
    const c = Object.fromEntries(target.considered!.map((x) => [x.instance, x]));
    expect(c.a!.headroom).toBeLessThan(c.b!.headroom);
    expect(c.a!.quota).toBe(c.b!.quota);
    expect(target.instance).toBe("a");
  });

  test("ranking is deterministic: the same state selects the same target", () => {
    const db = scopeStore("pool-deterministic");
    pooled(db, ["a", "b", "c"]);
    recordRun(db, "kimi", "a", at(-1_000));
    seedPriors(db, "onboarding", [{ model: "kimi-k3", mean: 3 }]);
    const first = pick(db);
    expect(pick(db).considered).toEqual(first.considered);
    expect(pick(db).instance).toBe(first.instance);
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

  test("reports prior and observed scores separately, per canonical model", () => {
    const db = scopeStore("list-scores");
    expect(listModels(db).find((r) => r.model === "kimi-k3")!).toMatchObject({
      rating: "unrated",
      scores: { observed: null, nEff: 0, prior: null, blended: null },
    });

    seedPriors(db, "onboarding", [{ model: "kimi-k3", mean: 4.5 }]);
    const rated = listModels(db).find((r) => r.model === "kimi-k3")!;
    expect(rated.rating).toBe("rated");
    expect(rated.scores).toMatchObject({ observed: null, prior: 4.5, blended: 4.5 });
    // A seeded prior must not make an unrelated model look rated.
    expect(listModels(db).find((r) => r.model === "opus-5")!.rating).toBe("unrated");
  });

  test("per-instance quota appears only where the app has a pool", () => {
    const db = scopeStore("list-pool");
    pooled(db, ["a", "b"]);
    recordRun(db, "kimi", "a", at(-1_000));
    const until = recordAdmissionFailure(db, "kimi", "b", NOW);

    const rows = listModels(db, NOW);
    expect(rows.find((r) => r.app === "kimi")!.pool).toEqual([
      { instance: "a", headroom: expect.closeTo(0.94, 2) },
      { instance: "b", headroom: 1, coolingUntil: until },
    ]);
    expect(rows.find((r) => r.app === "codex")!.pool).toBeUndefined();
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
