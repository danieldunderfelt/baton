import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { AdapterSpec } from "../adapters/types.ts";
import { builtinAdapters } from "../adapters/builtin/index.ts";
import { openStore } from "../store/store.ts";
import { selectTarget } from "../registry/registry.ts";
import {
  activeDiscoveredSpecs,
  adapterSpecJsonSchema,
  getDiscovered,
  specDigest,
  submitSpec,
  validateSpec,
} from "./discovery.ts";
import { setAdapterEnabled, testAdapter } from "./diagnostics.ts";
import { runAdapters } from "../cli/adapters.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

function workspace(): { db: Database; binary: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "baton-discovery-"));
  const binary = join(dir, "fake-agent");
  writeFileSync(binary, "#!/bin/sh\nprintf 'fake-agent 1.0\\n'\n");
  chmodSync(binary, 0o755);
  const db = openStore(join(dir, "baton.db"));
  cleanup.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, binary, dir };
}

function spec(binary: string, overrides: Partial<AdapterSpec> = {}): AdapterSpec {
  return {
    app: "fake-agent",
    adapterVersion: 1,
    binary,
    models: [{ model: "fake-model", slug: "fake/slug" }],
    invoke: {
      argv: ["run", "-m", "{slug}", "{autonomyFlags}"],
      promptVia: "stdin",
      extract: { kind: "text" },
    },
    autonomyFlags: { readonly: ["--readonly"], full: [] },
    defaultAutonomy: "full",
    defaultTimeoutMs: 60_000,
    admissionFailurePatterns: ["rate limit"],
    ...overrides,
  };
}

describe("adapter data contract", () => {
  test("one schema validates built-ins and supplies discovery JSON schema", () => {
    for (const adapter of builtinAdapters) {
      const result = validateSpec(adapter, { builtin: true });
      expect(result.ok, JSON.stringify(result)).toBe(true);
    }
    expect(adapterSpecJsonSchema().type).toBe("object");
  });

  test("literal argv punctuation and command names need no shell approval", () => {
    const adapter = spec("fake-agent");
    adapter.invoke.argv.push('--config={"name":"a;b","args":"$(literal)"}');
    adapter.invoke.argv.push("--empty", "");
    adapter.autonomyFlags.full = ["a|b", "`literal`", "x\ny"];
    expect(validateSpec(adapter).ok).toBe(true);
  });

  test("invalid argv contracts and NUL fail before storage", () => {
    for (const argv of [
      ["run"],
      ["{slug}", "{slug}"],
      ["{slug}", "{prompt}"],
      ["{slug}", "x{autonomyFlags}"],
      ["{slug}", "x\0y"],
    ]) {
      const adapter = spec("/bin/fake");
      adapter.invoke.argv = argv;
      expect(validateSpec(adapter).ok).toBe(false);
    }
  });

  test("resume requires exactly one handle and a handle extractor", () => {
    expect(validateSpec(spec("fake", { resume: { argv: ["resume", "{sessionRef}"] } })).ok).toBe(
      false,
    );
    const sessionRef = { kind: "json", path: "session" } as const;
    expect(
      validateSpec(spec("fake", { sessionRef, resume: { argv: ["resume", "{sessionRef}"] } })).ok,
    ).toBe(true);
    expect(validateSpec(spec("fake", { sessionRef, resume: { argv: ["resume"] } })).ok).toBe(false);
  });

  test("rejects unsupported defaults, duplicate routes, unknown fields and builtin collisions", () => {
    for (const adapter of [
      spec("fake", { autonomyFlags: { readonly: [] } }),
      spec("fake", {
        models: [
          { model: "a", slug: "a" },
          { model: "a", slug: "b" },
        ],
      }),
      spec("fake", { app: "codex" }),
      { ...spec("fake"), unexpected: true },
    ])
      expect(validateSpec(adapter).ok).toBe(false);
  });

  test("fingerprints ignore object key order but retain invocation changes", () => {
    const adapter = spec("fake");
    const reordered = {
      ...adapter,
      invoke: {
        extract: adapter.invoke.extract,
        promptVia: adapter.invoke.promptVia,
        argv: adapter.invoke.argv,
      },
    };
    expect(specDigest(reordered)).toBe(specDigest(adapter));
    expect(specDigest({ ...adapter, binary: "different" })).not.toBe(specDigest(adapter));
  });
});

describe("registration without activation gates", () => {
  test("aggregate diagnostics skip disabled adapters and continue to later registrations", async () => {
    const { db, binary } = workspace();
    submitSpec(db, spec(binary, { app: "a-disabled" }));
    submitSpec(db, spec(binary, { app: "z-enabled" }));
    setAdapterEnabled(db, "a-disabled", false);
    const previousPath = process.env.PATH;
    const output = spyOn(console, "log").mockImplementation(() => {});
    const errors = spyOn(console, "error").mockImplementation(() => {});
    process.env.PATH = "/nonexistent";
    try {
      expect(await runAdapters(db, ["test", "--all"])).toBe(1);
      expect(output.mock.calls.flat().join("\n")).toContain("a-disabled: skipped (disabled)");
      expect(getDiscovered(db, "z-enabled")?.diagnostic?.passed).toBe(false);
      expect(await runAdapters(db, ["test", "--all", "--structural"])).toBe(0);
      expect(output.mock.calls.flat().join("\n")).toContain("a-disabled: valid");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      output.mockRestore();
      errors.mockRestore();
    }
  });

  test("legacy pending registrations migrate enabled while explicit rejections stay disabled", () => {
    const { db, binary, dir } = workspace();
    db.exec(`DROP TABLE discovered_adapters;
      CREATE TABLE discovered_adapters (app TEXT PRIMARY KEY, spec TEXT NOT NULL,
      status TEXT NOT NULL, submitted_at TEXT NOT NULL, reviewed_at TEXT, binary_version TEXT, notes TEXT);
      DELETE FROM schema_migrations WHERE version = 11;`);
    for (const status of ["quarantined", "approved", "active", "stale", "rejected"]) {
      db.query(
        "INSERT INTO discovered_adapters (app,spec,status,submitted_at) VALUES (?,?,?,?)",
      ).run(status, JSON.stringify(spec(binary, { app: status })), status, "2026-01-01T00:00:00Z");
    }
    const reopened = openStore(join(dir, "baton.db"));
    try {
      for (const status of ["quarantined", "approved", "active", "stale", "rejected"]) {
        expect(getDiscovered(reopened, status)?.status).toBe(
          status === "rejected" ? "disabled" : "enabled",
        );
      }
    } finally {
      reopened.close();
    }
  });

  test("registration is immediately routable and identical retries preserve state", async () => {
    const { db, binary } = workspace();
    const adapter = spec(binary);
    const first = submitSpec(db, adapter, "2026-01-01T00:00:00Z");
    expect(first.ok && first.record.status).toBe("enabled");
    expect((await selectTarget(db, "fake-model")).spec.app).toBe("fake-agent");
    const again = submitSpec(db, adapter, "2026-02-01T00:00:00Z");
    expect(again.ok && again.changed).toBe(false);
    expect(getDiscovered(db, "fake-agent")?.submittedAt).toBe("2026-01-01T00:00:00Z");
  });

  test("disabled state survives replacement; enable works directly", async () => {
    const { db, binary } = workspace();
    submitSpec(db, spec(binary));
    setAdapterEnabled(db, "fake-agent", false);
    submitSpec(db, spec(binary, { adapterVersion: 2 }));
    expect(activeDiscoveredSpecs(db)).toEqual([]);
    await expect(selectTarget(db, "fake-model")).rejects.toThrow();
    setAdapterEnabled(db, "fake-agent", true);
    expect((await selectTarget(db, "fake-model")).spec.adapterVersion).toBe(2);
  });

  test("an invalid replacement leaves the working registration intact", () => {
    const { db, binary } = workspace();
    submitSpec(db, spec(binary));
    expect(submitSpec(db, spec(binary, { models: [] })).ok).toBe(false);
    expect(getDiscovered(db, "fake-agent")?.spec.models).toHaveLength(1);
  });

  test("optional diagnostic obeys ceiling and records failure without disabling", async () => {
    const { db, binary, dir } = workspace();
    submitSpec(db, spec(binary));
    db.query("INSERT INTO settings VALUES (?, ?)").run("max_autonomy:fake-agent", "readonly");
    let permission: string | undefined;
    const result = await testAdapter(db, "fake-agent", {
      cwd: dir,
      exec: async (request) => {
        permission = request.autonomy;
        return {
          ok: true,
          output: "wrong answer",
          started: true,
          exitCode: 0,
          timedOut: false,
          rawTail: "",
          durationMs: 1,
        };
      },
    });
    expect(permission).toBe("readonly");
    expect(result.passed).toBe(false);
    expect(getDiscovered(db, "fake-agent")).toMatchObject({
      status: "enabled",
      diagnostic: { passed: false },
    });
  });

  test("an unsupported diagnostic ceiling never calls the executable", async () => {
    const { db, binary } = workspace();
    submitSpec(db, spec(binary, { autonomyFlags: { full: [] } }));
    db.query("INSERT INTO settings VALUES (?, ?)").run("max_autonomy:fake-agent", "readonly");
    let called = false;
    const result = await testAdapter(db, "fake-agent", {
      exec: async () => {
        called = true;
        throw new Error("must not run");
      },
    });
    expect(result.passed).toBe(false);
    expect(called).toBe(false);
  });
});
