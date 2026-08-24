import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyFailure, executeAdapter, isAdmissionFailure } from "../executor.ts";
import { AUTONOMY_ORDER, type AdapterSpec, type ExecResult, type ExtractSpec } from "../types.ts";
import {
  builtinAdapters,
  claudeCodeAdapter,
  codexAdapter,
  getAdapter,
  opencodeAdapter,
} from "./index.ts";

/**
 * Structural conformance of the pinned built-ins, plus a live canary per
 * adapter that burns real subscription quota — hence BATON_LIVE_TESTS=1.
 */

/** Anything a shell would treat specially: argv must never need quoting. */
const SHELL_METACHARS = /[;&|<>$`(){}[\]!*?~"'\\\s]/;
const PLACEHOLDERS = new Set(["{slug}", "{prompt}", "{autonomyFlags}"]);

const count = (argv: string[], token: string): number =>
  argv.filter((element) => element === token).length;

/** Apps whose credential store no env var relocates (probed, see opencode.ts). */
const NO_IDENTITY_ENV = new Set(["opencode"]);

describe("registry", () => {
  test("exposes every built-in app in a deterministic order", () => {
    expect(builtinAdapters.map((a) => a.app)).toEqual([
      "claude-code",
      "codex",
      "kimi",
      "opencode",
    ]);
  });

  test("getAdapter resolves by app id", () => {
    for (const spec of builtinAdapters) expect(getAdapter(spec.app)).toBe(spec);
    expect(getAdapter("cursor-agent")).toBeUndefined();
    expect(getAdapter("")).toBeUndefined();
  });

  test("no route reaches a haiku model", () => {
    for (const spec of builtinAdapters) {
      for (const route of spec.models) {
        expect(`${route.model} ${route.slug}`.toLowerCase()).not.toInclude("haiku");
      }
    }
  });
});

describe.each(builtinAdapters.map((spec) => [spec.app, spec] as const))("%s spec", (_app, spec) => {
  test("identity fields are filled", () => {
    expect(spec.app).not.toBe("");
    expect(spec.adapterVersion).toBe(1);
    if (NO_IDENTITY_ENV.has(spec.app)) expect(spec.identityEnv).toBeUndefined();
    else expect(spec.identityEnv).toMatch(/^[A-Z][A-Z0-9_]*$/);
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

  test("work-started patterns are declared and usable", () => {
    // Present on every built-in, even when empty: an omission would read as
    // "not audited", and the audit below is what keeps failover honest.
    expect(Array.isArray(spec.workStartedPatterns)).toBe(true);
    for (const pattern of spec.workStartedPatterns ?? []) {
      expect(pattern.trim().length).toBeGreaterThan(0);
    }
  });

  test("no admission pattern that can fire mid-run is left unguarded", () => {
    // Quota and upstream messages read identically whether they arrive at the
    // door or after four minutes of edits, so an adapter may only list one if
    // it can also prove work started (PLAN.md §Failover on admission failure
    // only). Auth/config signatures are startup-only and need no guard.
    const guarded = (spec.workStartedPatterns ?? []).length > 0;
    for (const pattern of spec.admissionFailurePatterns) {
      if (MID_RUN_PLAUSIBLE.test(pattern)) expect(guarded).toBe(true);
    }
  });
});

/** Admission text that a healthy, already-working run can also produce. */
const MID_RUN_PLAUSIBLE = /rate.?limit|usage limit|quota|429|too many|upstream|503|overload/i;

test("claude-code lists only the verified auth signature", () => {
  // The inferred "usage limit reached" string used to live here; it is exactly
  // the message a four-minute run prints after editing files, and claude's
  // single-envelope output offers no work-started marker to guard it with, so
  // matching it would have replayed the prompt on another account.
  expect(claudeCodeAdapter.admissionFailurePatterns).toEqual(["Not logged in"]);
  expect(claudeCodeAdapter.workStartedPatterns).toEqual([]);
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

// --- Recorded output: the extraction contract, checked offline. -------------

/**
 * Replays stdout captured from a real run of the app through the executor, so
 * the adapter's extract/sessionRef paths are checked against the actual stream
 * format without burning quota. The stand-in binary ignores argv (argv is the
 * executor's contract, covered in executor.test.ts) and reproduces the exit
 * code, which for these apps is not a reliable success signal on its own.
 */
function replay(spec: AdapterSpec, stdout: string, exitCode = 0): Promise<ExecResult> {
  const dir = mkdtempSync(join(tmpdir(), "baton-replay-"));
  const sample = join(dir, "stdout");
  const script = join(dir, "cli");
  writeFileSync(sample, stdout);
  writeFileSync(script, `#!/bin/sh\ncat ${sample}\nexit ${exitCode}\n`);
  chmodSync(script, 0o755);
  return executeAdapter({
    spec,
    binaryPath: script,
    slug: spec.models[0]!.slug,
    prompt: "hello",
    cwd: dir,
    env: { PATH: process.env.PATH },
    autonomy: spec.defaultAutonomy,
    timeoutMs: 10_000,
  });
}

const json = (value: unknown): string => `${JSON.stringify(value)}\n`;

describe("claude-code recorded output", () => {
  // Field selection from a real `claude -p --output-format json` result object.
  const result = (fields: Record<string, unknown>): string =>
    json({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "d5ed6a6f-2f1b-4f0a-9a2e-1f5a2c3d4e5f",
      total_cost_usd: 0.0088912,
      api_error_status: null,
      ...fields,
    });

  test("answer comes from `result`, session id from `session_id`", async () => {
    const res = await replay(claudeCodeAdapter, result({ result: "BATON_CANARY" }));
    expect(res.ok).toBe(true);
    expect(res.output).toBe("BATON_CANARY");
    expect(res.sessionRef).toBe("d5ed6a6f-2f1b-4f0a-9a2e-1f5a2c3d4e5f");
  });

  test("a not-logged-in body cools the instance down even though it exits 1", async () => {
    const res = await replay(
      claudeCodeAdapter,
      result({ is_error: true, result: "Not logged in · Please run /login" }),
      1,
    );
    expect(res.ok).toBe(false);
    expect(isAdmissionFailure(claudeCodeAdapter, res)).toBe(true);
  });

  test("a bad model slug fails the run without cooling the instance down", async () => {
    const res = await replay(
      claudeCodeAdapter,
      result({
        is_error: true,
        api_error_status: 404,
        result:
          "There's an issue with the selected model (nope). It may not exist or you may not have access to it.",
      }),
      1,
    );
    expect(res.ok).toBe(false);
    // A route defect, not an instance one: failing over to another account
    // would just reproduce it.
    expect(isAdmissionFailure(claudeCodeAdapter, res)).toBe(false);
  });
});

describe("opencode recorded output", () => {
  const SESSION = "ses_fcaacce49ffeGLwbsoPzN9V9Ac";
  const text = (value: string): string =>
    json({ type: "text", sessionID: SESSION, part: { type: "text", text: value } });
  const step = (type: string): string => json({ type, sessionID: SESSION, part: { type } });

  test("answer is the last text part, session id comes off any event", async () => {
    const res = await replay(
      opencodeAdapter,
      step("step_start") + text("thinking out loud") + text("BATON_CANARY") + step("step_finish"),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toBe("BATON_CANARY");
    expect(res.sessionRef).toBe(SESSION);
  });

  // Verbatim shape of a live upstream rejection; json mode exited 0 for it.
  const upstream503 = json({
    type: "error",
    sessionID: SESSION,
    error: {
      name: "APIError",
      data: {
        message: "Error from provider (Console): Upstream request failed: Endpoint is unavailable.",
        statusCode: 503,
        isRetryable: true,
      },
    },
  });

  test("an error event fails the run despite the exit code saying success", async () => {
    const res = await replay(opencodeAdapter, step("step_start") + upstream503, 0);
    expect(res.ok).toBe(false);
    // The run had started, so this is a plain failure: replaying the prompt on
    // another instance could repeat whatever that first step already did.
    expect(classifyFailure(opencodeAdapter, res)).toBe("failure");
  });

  test("an error after a streamed answer beats that answer", async () => {
    const res = await replay(
      opencodeAdapter,
      step("step_start") + text("here is half an answer") + upstream503,
      0,
    );
    // Before errorWhen this returned the partial text with ok: true.
    expect(res.ok).toBe(false);
    expect(res.output).toBeUndefined();
    expect(res.error).toContain("Upstream request failed");
    expect(classifyFailure(opencodeAdapter, res)).toBe("failure");
  });

  test("a 429 envelope before any step cools the instance down", async () => {
    // Inferred shape (see opencode.ts): no rate limit was reachable live, so
    // this pins the pattern to the envelope the 503 proved opencode emits.
    const res = await replay(
      opencodeAdapter,
      json({
        type: "error",
        sessionID: SESSION,
        error: { name: "APIError", data: { message: "Too many requests", statusCode: 429 } },
      }),
      1,
    );
    expect(res.ok).toBe(false);
    expect(classifyFailure(opencodeAdapter, res)).toBe("admission");
  });
});

describe("codex recorded output", () => {
  const THREAD = "0199e6a1-6f5c-7a4e-9c3d-2b1a0f9e8d7c";
  const started =
    json({ type: "thread.started", thread_id: THREAD }) + json({ type: "turn.started" });
  const message = (text: string): string =>
    json({ type: "item.completed", item: { id: "item_1", type: "agent_message", text } });

  test("answer is the last agent message, thread id is the session ref", async () => {
    const res = await replay(codexAdapter, started + message("BATON_CANARY"));
    expect(res.ok).toBe(true);
    expect(res.output).toBe("BATON_CANARY");
    expect(res.sessionRef).toBe(THREAD);
  });

  test("a failed turn fails the run even after an agent message", async () => {
    const res = await replay(
      codexAdapter,
      started +
        message("half an answer") +
        json({ type: "turn.failed", error: { message: "stream disconnected" } }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("stream disconnected");
  });

  test("a 401 with no turn under way cools the instance down", async () => {
    const res = await replay(
      codexAdapter,
      json({ type: "thread.started", thread_id: THREAD }) +
        "ERROR: unexpected status 401 Unauthorized\n",
      1,
    );
    expect(classifyFailure(codexAdapter, res)).toBe("admission");
  });

  test("the same 401 text once the turn is running is a plain failure", async () => {
    const res = await replay(
      codexAdapter,
      started + "ERROR: unexpected status 401 Unauthorized\n",
      1,
    );
    expect(classifyFailure(codexAdapter, res)).toBe("failure");
  });
});

// --- Live canary: real CLI, real subscription quota. ------------------------

const LIVE = Bun.env.BATON_LIVE_TESTS === "1";
const CANARY_TIMEOUT_MS = 120_000;
/** Cheapest route of an app whose first route is expensive: a canary proves the
 * plumbing, so it must not spend a precious window (PLAN.md §Quota-aware cost). */
const CANARY_SLUG: Record<string, string> = { "claude-code": "sonnet" };

describe.skipIf(!LIVE)("live canary", () => {
  test.each(builtinAdapters.map((spec) => [spec.app, spec] as const))(
    "%s returns the canary token through the real CLI",
    async (_app, spec: AdapterSpec) => {
      const slug = CANARY_SLUG[spec.app] ?? spec.models[0]!.slug;
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
