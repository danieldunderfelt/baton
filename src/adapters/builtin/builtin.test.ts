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
  cursorAdapter,
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
const RESUME_PLACEHOLDERS = new Set([...PLACEHOLDERS, "{sessionRef}"]);
/** Session flags whose value is optional — an absent one goes interactive. */
const OPTIONAL_VALUE_SESSION_FLAGS = ["-r", "--resume", "-S", "--session"];

const count = (argv: string[], token: string): number =>
  argv.filter((element) => element === token).length;

/**
 * Apps with no config-dir style identity var, so no instances and no pool
 * (probed: see cursor.ts).
 */
const NO_IDENTITY_ENV = new Set(["cursor-agent"]);

describe("registry", () => {
  test("exposes every built-in app in a deterministic order", () => {
    expect(builtinAdapters.map((a) => a.app)).toEqual([
      "claude-code",
      "codex",
      "cursor-agent",
      "kimi",
      "opencode",
    ]);
  });

  test("getAdapter resolves by app id", () => {
    for (const spec of builtinAdapters) expect(getAdapter(spec.app)).toBe(spec);
    expect(getAdapter("aider")).toBeUndefined();
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

  test("resume argv substitutes exactly like invoke argv", () => {
    const argv = spec.resume?.argv;
    if (!argv) return; // Declared per app; the roster is pinned below.
    // A resume that cannot be handed a handle is unusable by construction.
    expect(spec.sessionRef).toBeDefined();
    expect(count(argv, "{sessionRef}")).toBe(1);
    // promptVia and extract are inherited, so the prompt placeholder must
    // follow the same rule the first turn did.
    expect(count(argv, "{prompt}")).toBe(spec.invoke.promptVia === "argv" ? 1 : 0);
    for (const element of argv) {
      if (RESUME_PLACEHOLDERS.has(element)) continue;
      expect(element).not.toInclude("{");
      expect(element).not.toBe("");
      expect(element).not.toMatch(SHELL_METACHARS);
    }
  });

  test("an optional-value session flag is followed by the handle itself", () => {
    const argv = spec.resume?.argv ?? [];
    // `claude -r [value]` and `kimi -S [id]` open an interactive picker when
    // the value is missing, which non-interactively means a hung run.
    for (const flag of OPTIONAL_VALUE_SESSION_FLAGS) {
      const at = argv.indexOf(flag);
      if (at !== -1) expect(argv[at + 1]).toBe("{sessionRef}");
    }
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

describe("resume roster", () => {
  test("every built-in declares a help-verified non-interactive resume", () => {
    // Every app documents a resume flag on the very command Baton already runs
    // non-interactively (`codex exec resume`, `claude -r`, `cursor-agent
    // --resume`, `kimi -S`, `opencode run -s`). codex's is exercised live (see
    // the canary below) and cursor-agent's was verified live while writing the
    // adapter (a second turn recalled the first); the rest are verified against
    // --help, which is what the phase-3 brief asks for.
    expect(builtinAdapters.filter((s) => s.resume).map((s) => s.app)).toEqual([
      "claude-code",
      "codex",
      "cursor-agent",
      "kimi",
      "opencode",
    ]);
  });

  test("codex asks for the prompt on stdin explicitly", () => {
    // `codex exec` documents "if not provided as an argument (or if `-` is
    // used), instructions are read from stdin"; `codex exec resume` documents
    // only the `-` form, so the positional is passed rather than assumed.
    const argv = codexAdapter.resume!.argv;
    expect(argv.slice(0, 4)).toEqual(["exec", "resume", "{sessionRef}", "-"]);
    expect(codexAdapter.invoke.promptVia).toBe("stdin");
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

// --- Recorded output: the extraction contract, checked offline. -------------

/**
 * Replays stdout captured from a real run of the app through the executor, so
 * the adapter's extract/sessionRef paths are checked against the actual stream
 * format without burning quota. The stand-in binary ignores argv (argv is the
 * executor's contract, covered in executor.test.ts) and reproduces the exit
 * code, which for these apps is not a reliable success signal on its own.
 */
function replay(spec: AdapterSpec, stdout: string, exitCode = 0, stderr = ""): Promise<ExecResult> {
  const dir = mkdtempSync(join(tmpdir(), "baton-replay-"));
  const sample = join(dir, "stdout");
  const errSample = join(dir, "stderr");
  const script = join(dir, "cli");
  writeFileSync(sample, stdout);
  writeFileSync(errSample, stderr);
  writeFileSync(script, `#!/bin/sh\ncat ${sample}\ncat ${errSample} >&2\nexit ${exitCode}\n`);
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

describe("cursor-agent recorded output", () => {
  const SESSION = "f0d6b505-1095-47ee-a6fb-59aede2de90c";
  // Verbatim event shapes from a live `--output-format stream-json` run.
  const init = json({
    type: "system",
    subtype: "init",
    apiKeySource: "login",
    session_id: SESSION,
    model: "Cursor Grok 4.6 High",
  });
  const assistant = (text: string): string =>
    json({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text }] },
      session_id: SESSION,
    });
  const result = (fields: Record<string, unknown>): string =>
    json({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 4694,
      session_id: SESSION,
      ...fields,
    });

  test("answer is the terminal result event, session id comes off the first", async () => {
    const res = await replay(
      cursorAdapter,
      // The assistant event carries a partial message on purpose: the terminal
      // result is the canonical answer, and reading the content array instead
      // would return this.
      init + assistant("Let me think") + result({ result: "BATON_CANARY" }),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toBe("BATON_CANARY");
    expect(res.sessionRef).toBe(SESSION);
  });

  test("is_error fails the run even though the envelope carries a result string", async () => {
    // subtype is prose and the exit code has been 0 for failed turns elsewhere;
    // is_error is the field to branch on.
    const res = await replay(
      cursorAdapter,
      init + result({ subtype: "error", is_error: true, result: "Conversation was interrupted" }),
    );
    expect(res.ok).toBe(false);
    expect(res.output).toBeUndefined();
    expect(res.error).toContain("Conversation was interrupted");
  });

  test("a logged-out config cools the instance down though it printed no JSON", async () => {
    // Reproduced live by pointing HOME at an empty dir: --output-format is
    // ignored on the failure path, so this arrives as one plain stderr line.
    const res = await replay(
      cursorAdapter,
      "",
      1,
      "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.\n",
    );
    expect(res.ok).toBe(false);
    expect(classifyFailure(cursorAdapter, res)).toBe("admission");
  });

  test("a bad model slug fails the run without cooling the instance down", async () => {
    const res = await replay(
      cursorAdapter,
      "",
      1,
      "Cannot use this model: cursor-not-a-model. Available models: auto, gpt-5.3-codex, …\n",
    );
    expect(res.ok).toBe(false);
    // A route defect: every other account would reject the same slug.
    expect(classifyFailure(cursorAdapter, res)).toBe("failure");
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

  /**
   * The one live resume, on the cheapest verified path. Only a second turn
   * that remembers the first proves the whole chain: the handle extraction,
   * the resume argv, and the app actually restoring the session — none of
   * which a --help reading can establish.
   */
  test(
    "codex remembers the first turn when resumed",
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "baton-resume-canary-"));
      const slug = "gpt-5.6-luna"; // cheapest codex route
      const env = { ...process.env, BATON_HOPS: "1" };

      const first = await executeAdapter({
        spec: codexAdapter,
        slug,
        prompt: "Say the word apple. Reply with just that word.",
        cwd,
        env,
        autonomy: codexAdapter.defaultAutonomy,
        timeoutMs: CANARY_TIMEOUT_MS,
      });
      expect(first.ok).toBe(true);
      expect(first.sessionRef).toBeTruthy();

      const resumed = await executeAdapter({
        spec: resumeInvocation(codexAdapter, first.sessionRef ?? ""),
        slug,
        prompt: "Repeat the word you just said.",
        cwd,
        env,
        autonomy: codexAdapter.defaultAutonomy,
        timeoutMs: CANARY_TIMEOUT_MS,
      });
      expect(resumed.error).toBeUndefined();
      expect(resumed.ok).toBe(true);
      expect(resumed.output?.toLowerCase()).toInclude("apple");
    },
    2 * (CANARY_TIMEOUT_MS + 30_000),
  );
});

/**
 * The resume invocation as a one-off spec — the same substitution the
 * supervisor performs before handing a resumed attempt to the executor
 * (`{sessionRef}` is run state; every other placeholder stays the executor's).
 */
function resumeInvocation(spec: AdapterSpec, sessionRef: string): AdapterSpec {
  const argv = spec.resume?.argv ?? [];
  return {
    ...spec,
    invoke: { ...spec.invoke, argv: argv.map((e) => e.replaceAll("{sessionRef}", sessionRef)) },
  };
}
