import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeAdapter } from "../executor.ts";
import { AUTONOMY_ORDER, type AdapterSpec, type ExtractSpec } from "../types.ts";
import { builtinAdapters, getAdapter } from "./index.ts";

/**
 * Structural conformance of the pinned built-ins, plus a live canary per
 * adapter that burns real subscription quota — hence BATON_LIVE_TESTS=1.
 */

/** Anything a shell would treat specially: argv must never need quoting. */
const SHELL_METACHARS = /[;&|<>$`(){}[\]!*?~"'\\\s]/;
const PLACEHOLDERS = new Set(["{slug}", "{prompt}", "{autonomyFlags}"]);

const count = (argv: string[], token: string): number =>
  argv.filter((element) => element === token).length;

describe("registry", () => {
  test("exposes codex and kimi in a deterministic order", () => {
    expect(builtinAdapters.map((a) => a.app)).toEqual(["codex", "kimi"]);
  });

  test("getAdapter resolves by app id", () => {
    for (const spec of builtinAdapters) expect(getAdapter(spec.app)).toBe(spec);
    expect(getAdapter("opencode")).toBeUndefined();
    expect(getAdapter("")).toBeUndefined();
  });
});

describe.each(builtinAdapters.map((spec) => [spec.app, spec] as const))("%s spec", (_app, spec) => {
  test("identity fields are filled", () => {
    expect(spec.app).not.toBe("");
    expect(spec.adapterVersion).toBe(1);
    expect(spec.identityEnv).toMatch(/^[A-Z][A-Z0-9_]*$/);
    expect(spec.defaultTimeoutMs).toBe(300_000);
  });

  test("binary is a bare executable name, resolved elsewhere", () => {
    expect(spec.binary).not.toBe("");
    expect(spec.binary).not.toInclude("/");
    expect(spec.binary).not.toMatch(SHELL_METACHARS);
  });

  test("models are non-empty with unique canonical ids", () => {
    expect(spec.models.length).toBeGreaterThan(0);
    for (const route of spec.models) {
      expect(route.model).not.toBe("");
      expect(route.slug).not.toBe("");
    }
    const canonical = spec.models.map((r) => r.model);
    expect(new Set(canonical).size).toBe(canonical.length);
  });

  test("argv carries each placeholder exactly as the executor substitutes it", () => {
    const { argv, promptVia } = spec.invoke;
    expect(count(argv, "{slug}")).toBe(1);
    expect(count(argv, "{prompt}")).toBe(promptVia === "argv" ? 1 : 0);
    expect(count(argv, "{autonomyFlags}")).toBe(1);
    // Placeholders are whole elements — never interpolated into a larger string.
    for (const element of argv) {
      if (PLACEHOLDERS.has(element)) continue;
      expect(element).not.toInclude("{");
    }
  });

  test("no argv element or autonomy flag needs shell quoting", () => {
    const literals = [
      ...spec.invoke.argv.filter((e) => !PLACEHOLDERS.has(e)),
      ...Object.values(spec.autonomyFlags).flat(),
    ];
    for (const element of literals) {
      expect(element).not.toBe("");
      expect(element).not.toMatch(SHELL_METACHARS);
    }
  });

  test("extract spec is well-formed", () => {
    expectWellFormedExtract(spec.invoke.extract);
    if (spec.sessionRef) expectWellFormedExtract(spec.sessionRef);
  });

  test("autonomy levels are known and the default is supported", () => {
    for (const level of Object.keys(spec.autonomyFlags)) {
      expect(AUTONOMY_ORDER as string[]).toContain(level);
    }
    expect(spec.autonomyFlags[spec.defaultAutonomy]).toBeDefined();
    expect(spec.defaultAutonomy).toBe("full");
  });

  test("admission failure patterns are usable substrings", () => {
    expect(spec.admissionFailurePatterns.length).toBeGreaterThan(0);
    for (const pattern of spec.admissionFailurePatterns) {
      expect(pattern.trim().length).toBeGreaterThan(0);
    }
  });
});

function expectWellFormedExtract(extract: ExtractSpec): void {
  expect(["text", "json", "jsonl"]).toContain(extract.kind);
  if (extract.kind === "text") return;
  expect(extract.path).not.toBe("");
  expect(extract.path.split(".").every((segment) => segment.length > 0)).toBe(true);
  if (extract.kind === "jsonl") {
    expect(["first", "last"]).toContain(extract.take);
    if (extract.where) {
      expect(extract.where.path).not.toBe("");
      expect(extract.where.equals).not.toBe("");
    }
  }
}

// --- Live canary: real CLI, real subscription quota. ------------------------

const LIVE = Bun.env.BATON_LIVE_TESTS === "1";
const CANARY_TIMEOUT_MS = 120_000;

describe.skipIf(!LIVE)("live canary", () => {
  test.each(builtinAdapters.map((spec) => [spec.app, spec] as const))(
    "%s returns the canary token through the real CLI",
    async (_app, spec: AdapterSpec) => {
      const slug = spec.models[0]!.slug;
      const result = await executeAdapter({
        spec,
        slug,
        prompt: "Reply with exactly: BATON_CANARY",
        // Not a git repo: also proves the trusted-directory flags are right.
        cwd: mkdtempSync(join(tmpdir(), "baton-canary-")),
        env: { ...process.env, BATON_HOPS: "1" },
        autonomy: spec.defaultAutonomy,
        timeoutMs: CANARY_TIMEOUT_MS,
      });
      expect(result.error).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(result.output).toBe("BATON_CANARY");
      // The only place the sessionRef extraction can be checked against the real
      // stream format; a bad path would silently stay undefined in production.
      if (spec.sessionRef) expect(result.sessionRef).toBeTruthy();
    },
    CANARY_TIMEOUT_MS + 30_000,
  );
});
