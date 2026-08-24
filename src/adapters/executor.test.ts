import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeAdapter, isAdmissionFailure, killProcessGroup } from "./executor.ts";
import type { AdapterSpec, Autonomy, ExecRequest, ExtractSpec, InvokeSpec } from "./types.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-cli.ts");

interface Opts {
  mode: string;
  argv?: string[];
  extract?: ExtractSpec;
  promptVia?: InvokeSpec["promptVia"];
  prompt?: string;
  slug?: string;
  autonomy?: Autonomy;
  autonomyFlags?: AdapterSpec["autonomyFlags"];
  sessionRef?: ExtractSpec;
  onSpawn?: (pid: number) => void;
  patterns?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  binary?: string;
  binaryPath?: string;
}

function request(o: Opts): ExecRequest {
  const spec: AdapterSpec = {
    app: "fake",
    adapterVersion: 1,
    binary: o.binary ?? process.execPath,
    models: [{ model: "fake-model", slug: "fake/slug" }],
    invoke: {
      argv: [FIXTURE, ...(o.argv ?? [])],
      promptVia: o.promptVia ?? "stdin",
      extract: o.extract ?? { kind: "text" },
    },
    autonomyFlags: o.autonomyFlags ?? { readonly: [], edits: [], full: [] },
    ...(o.sessionRef ? { sessionRef: o.sessionRef } : {}),
    defaultAutonomy: "full",
    defaultTimeoutMs: 5_000,
    admissionFailurePatterns: o.patterns ?? [],
  };
  return {
    spec,
    ...(o.binaryPath ? { binaryPath: o.binaryPath } : {}),
    slug: o.slug ?? "fake/slug",
    prompt: o.prompt ?? "hello",
    cwd: import.meta.dir,
    env: { ...process.env, BATON_FAKE_MODE: o.mode, ...o.env },
    autonomy: o.autonomy ?? "full",
    timeoutMs: o.timeoutMs ?? 10_000,
    maxOutputBytes: o.maxOutputBytes,
    ...(o.onSpawn ? { onSpawn: o.onSpawn } : {}),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isDeadNow(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function isDead(pid: number, withinMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
}

describe("extraction", () => {
  test("text keeps trimmed stdout", async () => {
    const res = await executeAdapter(request({ mode: "text" }));
    expect(res.ok).toBe(true);
    expect(res.output).toBe("final answer from text mode");
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("json follows a dot-path", async () => {
    const res = await executeAdapter(
      request({ mode: "json", extract: { kind: "json", path: "result.text" } }),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toBe("final answer from json mode");
  });

  test("json dot-path indexes arrays numerically", async () => {
    const res = await executeAdapter(
      request({ mode: "json", extract: { kind: "json", path: "result.items.1" } }),
    );
    expect(res.output).toBe("beta");
  });

  test("json non-string values are serialized", async () => {
    const res = await executeAdapter(
      request({ mode: "json", extract: { kind: "json", path: "result.items" } }),
    );
    expect(res.output).toBe('["alpha","beta"]');
  });

  test("jsonl filters and takes the last match, skipping junk lines", async () => {
    const res = await executeAdapter(
      request({
        mode: "jsonl",
        extract: {
          kind: "jsonl",
          where: { path: "type", equals: "message" },
          path: "text",
          take: "last",
        },
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toBe("last message");
  });

  test("jsonl take:first", async () => {
    const res = await executeAdapter(
      request({
        mode: "jsonl",
        extract: {
          kind: "jsonl",
          where: { path: "type", equals: "message" },
          path: "text",
          take: "first",
        },
      }),
    );
    expect(res.output).toBe("first message");
  });

  test("jsonl without a where clause takes the last record", async () => {
    const res = await executeAdapter(
      request({ mode: "jsonl", extract: { kind: "jsonl", path: "tokens", take: "last" } }),
    );
    expect(res.output).toBe("12");
  });

  test("no matching jsonl record is a precise extraction failure on exit 0", async () => {
    const res = await executeAdapter(
      request({
        mode: "jsonl",
        extract: {
          kind: "jsonl",
          where: { path: "type", equals: "result" },
          path: "text",
          take: "last",
        },
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(0);
    expect(res.error).toBe("extraction failed: no JSONL record where type == result");
  });

  test("unparseable json is an extraction failure", async () => {
    const res = await executeAdapter(
      request({ mode: "text", extract: { kind: "json", path: "result" } }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("extraction failed: stdout is not valid JSON");
  });

  test("missing json path is an extraction failure naming the path", async () => {
    const res = await executeAdapter(
      request({ mode: "json", extract: { kind: "json", path: "result.missing.deep" } }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe('extraction failed: path "result.missing.deep" missing in JSON');
  });
});

describe("argv construction", () => {
  const echo: ExtractSpec = { kind: "json", path: "argv" };

  async function argvOf(o: Omit<Opts, "mode">): Promise<string[]> {
    const res = await executeAdapter(request({ ...o, mode: "argv", extract: echo }));
    expect(res.ok).toBe(true);
    return JSON.parse(res.output ?? "[]") as string[];
  }

  test("substitutes {slug} and expands {autonomyFlags} in place", async () => {
    const argv = await argvOf({
      argv: ["exec", "--model", "{slug}", "{autonomyFlags}", "--json"],
      autonomy: "readonly",
      autonomyFlags: { readonly: ["--sandbox", "read-only"], full: ["--yolo"] },
      slug: "gpt-5.6-sol",
    });
    expect(argv).toEqual(["exec", "--model", "gpt-5.6-sol", "--sandbox", "read-only", "--json"]);
  });

  test("appends autonomy flags when the token is absent", async () => {
    const argv = await argvOf({
      argv: ["run", "{slug}"],
      autonomy: "full",
      autonomyFlags: { full: ["--dangerously-skip-permissions"] },
    });
    expect(argv).toEqual(["run", "fake/slug", "--dangerously-skip-permissions"]);
  });

  test("an unsupported autonomy level refuses to spawn", async () => {
    const res = await executeAdapter(
      request({ mode: "argv", autonomy: "edits", autonomyFlags: { full: ["--yolo"] } }),
    );
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBeNull();
    expect(res.error).toContain("cannot run at autonomy 'edits'");
    expect(res.error).toContain("full");
  });

  test("{slug} substitutes inside a joined flag as one element", async () => {
    const argv = await argvOf({ argv: ["--model={slug}"], slug: "kimi-code/k3" });
    expect(argv).toEqual(["--model=kimi-code/k3"]);
  });

  test("{prompt} is one argv element under promptVia argv, never split", async () => {
    const argv = await argvOf({
      argv: ["-p", "{prompt}"],
      promptVia: "argv",
      prompt: "write a test; rm -rf / && echo $HOME 'quoted'",
    });
    expect(argv).toEqual(["-p", "write a test; rm -rf / && echo $HOME 'quoted'"]);
  });

  test("{prompt} is dropped from argv under promptVia stdin", async () => {
    const argv = await argvOf({ argv: ["-p", "{prompt}", "--json"], promptVia: "stdin" });
    expect(argv).toEqual(["-p", "--json"]);
  });
});

describe("prompt delivery", () => {
  test("stdin receives the prompt and is closed", async () => {
    const prompt = "multi\nline prompt with ünicode";
    const res = await executeAdapter(
      request({ mode: "stdin", prompt, extract: { kind: "json", path: "echo" } }),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toBe(prompt);
  });

  test("stdin is closed immediately under promptVia argv", async () => {
    const res = await executeAdapter(
      request({
        mode: "stdin",
        promptVia: "argv",
        argv: ["{prompt}"],
        prompt: "ignored",
        extract: { kind: "json", path: "echo" },
      }),
    );
    // The callee saw EOF on stdin instead of hanging; only the extracted
    // empty string makes this a (correct) extraction failure.
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.error).toBe("extraction failed: empty result");
    expect(res.rawTail).toContain('{"echo":""}');
  });
});

describe("failure modes", () => {
  test("timeout kills the whole process group", async () => {
    const res = await executeAdapter(
      request({ mode: "grandchild", timeoutMs: 600, env: { BATON_FAKE_SLEEP_MS: "30000" } }),
    );
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(res.error).toBe("timed out after 600ms");

    const line = res.rawTail.split("\n").find((l) => l.includes("grandchildPid"));
    expect(line).toBeDefined();
    const { grandchildPid } = JSON.parse(line ?? "{}") as { grandchildPid: number };
    expect(typeof grandchildPid).toBe("number");
    expect(await isDead(grandchildPid)).toBe(true);
  }, 20_000);

  test("does not return until a SIGTERM-ignoring descendant is actually dead", async () => {
    let leaderPid = 0;
    const res = await executeAdapter(
      request({
        mode: "stubborn-grandchild",
        timeoutMs: 400,
        env: { BATON_FAKE_SLEEP_MS: "30000" },
        onSpawn: (p) => {
          leaderPid = p;
        },
      }),
    );
    expect(res.timedOut).toBe(true);
    expect(res.error).toBe("timed out after 400ms");

    const line = res.rawTail.split("\n").find((l) => l.includes("grandchildPid"));
    const { grandchildPid } = JSON.parse(line ?? "{}") as { grandchildPid: number };
    expect(typeof grandchildPid).toBe("number");
    // No polling here on purpose: the executor must have confirmed the whole
    // group dead before resolving, not merely fired signals at it.
    expect(isDeadNow(grandchildPid)).toBe(true);
    expect(isDeadNow(leaderPid)).toBe(true);
  }, 30_000);

  test("nonzero exit reports the code and the stderr tail", async () => {
    const res = await executeAdapter(
      request({
        mode: "fail",
        env: { BATON_FAKE_EXIT: "7", BATON_FAKE_STDERR: "Error: usage limit reached for your plan" },
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(7);
    expect(res.timedOut).toBe(false);
    expect(res.error).toContain("exited with code 7");
    expect(res.error).toContain("usage limit reached for your plan");
    expect(res.rawTail).toContain("--- stderr ---");
  });

  test("a missing binary yields a spawn error, not a throw", async () => {
    const res = await executeAdapter(
      request({ mode: "text", binary: "/nonexistent/baton-fake-binary" }),
    );
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBeNull();
    expect(res.error).toContain("spawn failed");
  });
});

describe("binaryPath", () => {
  function poisonedPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "baton-path-"));
    const shim = join(dir, "baton-fake-shim");
    writeFileSync(shim, "#!/bin/sh\necho IMPOSTOR\n");
    chmodSync(shim, 0o755);
    return dir;
  }

  test("spawns the verified absolute path, not a PATH lookup of the bare name", async () => {
    const dir = poisonedPath();
    const res = await executeAdapter(
      request({
        mode: "text",
        binary: "baton-fake-shim",
        binaryPath: process.execPath,
        env: { PATH: dir },
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toBe("final answer from text mode");
  });

  test("negative control: without binaryPath the poisoned PATH wins", async () => {
    const dir = poisonedPath();
    const res = await executeAdapter(
      request({ mode: "text", binary: "baton-fake-shim", env: { PATH: dir } }),
    );
    expect(res.output).toBe("IMPOSTOR");
  });
});

describe("killProcessGroup", () => {
  test("reports a group that no longer exists as dead", async () => {
    const res = await killProcessGroup(999_999, { graceMs: 50, deadlineMs: 200 });
    expect(res.dead).toBe(true);
  });

  test("refuses pids that cannot name a real group", async () => {
    const res = await killProcessGroup(0);
    expect(res.dead).toBe(false);
    expect(res.why).toContain("refusing");
  });
});

describe("onSpawn", () => {
  test("reports the callee pid before the run finishes", async () => {
    const pids: number[] = [];
    const res = await executeAdapter(request({ mode: "text", onSpawn: (p) => pids.push(p) }));
    expect(res.ok).toBe(true);
    expect(pids).toHaveLength(1);
    expect(pids[0]).toBeGreaterThan(0);
  });

  test("a pid reported for a live callee names its process group", async () => {
    let pid = 0;
    const res = await executeAdapter(
      request({
        mode: "grandchild",
        timeoutMs: 600,
        env: { BATON_FAKE_SLEEP_MS: "30000" },
        onSpawn: (p) => {
          pid = p;
        },
      }),
    );
    expect(res.timedOut).toBe(true);
    expect(pid).toBeGreaterThan(0);
    // The executor killed -pid; if that pid were not the group leader the
    // grandchild would have survived (verified by negative control).
    expect(await isDead(pid)).toBe(true);
  }, 20_000);

  test("is not called when spawning fails", async () => {
    let called = false;
    const res = await executeAdapter(
      request({
        mode: "text",
        binary: "/nonexistent/baton-fake-binary",
        onSpawn: () => {
          called = true;
        },
      }),
    );
    expect(res.ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe("sessionRef", () => {
  test("extracts the app's session id alongside the answer", async () => {
    const res = await executeAdapter(
      request({
        mode: "json",
        extract: { kind: "json", path: "result.text" },
        sessionRef: { kind: "json", path: "session_id" },
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.sessionRef).toBe("sess-42");
  });

  test("is captured even when the run fails, so the run stays resumable", async () => {
    const res = await executeAdapter(
      request({
        mode: "json",
        extract: { kind: "json", path: "nope" },
        sessionRef: { kind: "json", path: "session_id" },
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.sessionRef).toBe("sess-42");
  });

  test("survives a verbose run that pushes the session line out of the tail", async () => {
    const res = await executeAdapter(
      request({
        mode: "session-head",
        maxOutputBytes: 2_000,
        env: { BATON_FAKE_BIG_BYTES: "40000" },
        extract: {
          kind: "jsonl",
          where: { path: "type", equals: "message" },
          path: "text",
          take: "last",
        },
        sessionRef: {
          kind: "jsonl",
          where: { path: "type", equals: "thread.started" },
          path: "thread_id",
          take: "first",
        },
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toBe("final answer");
    expect(res.rawTail).not.toContain("thread.started"); // the tail really lost it
    expect(res.sessionRef).toBe("th-99");
  });

  test("stays undefined when the spec declares none or nothing matches", async () => {
    expect((await executeAdapter(request({ mode: "text" }))).sessionRef).toBeUndefined();
    const missing = await executeAdapter(
      request({ mode: "text", sessionRef: { kind: "json", path: "session_id" } }),
    );
    expect(missing.ok).toBe(true);
    expect(missing.sessionRef).toBeUndefined();
  });
});

describe("output cap", () => {
  test("keeps the tail when output exceeds maxOutputBytes", async () => {
    const res = await executeAdapter(
      request({
        mode: "big",
        maxOutputBytes: 1_000,
        env: { BATON_FAKE_BIG_BYTES: "40000", BATON_FAKE_MARKER: "TAILMARKER" },
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.rawTail.length).toBe(1_000);
    expect(res.rawTail.endsWith("TAILMARKER")).toBe(true);
    expect(res.output?.endsWith("TAILMARKER")).toBe(true);
  });
});

describe("isAdmissionFailure", () => {
  const spec = request({ mode: "text", patterns: ["Usage limit reached", "429 too many"] }).spec;

  test("matches case-insensitively against rawTail", () => {
    const res = {
      ok: false,
      exitCode: 1,
      timedOut: false,
      rawTail: "stderr: usage LIMIT reached for your plan",
      durationMs: 1,
    };
    expect(isAdmissionFailure(spec, res)).toBe(true);
  });

  test("matches against the error string too", () => {
    const res = {
      ok: false,
      exitCode: 1,
      timedOut: false,
      rawTail: "",
      error: "exited with code 1: HTTP 429 Too Many Requests",
      durationMs: 1,
    };
    expect(isAdmissionFailure(spec, res)).toBe(true);
  });

  test("does not match unrelated failures, and never with no patterns", () => {
    const res = {
      ok: false,
      exitCode: 1,
      timedOut: false,
      rawTail: "TypeError: undefined is not a function",
      durationMs: 1,
    };
    expect(isAdmissionFailure(spec, res)).toBe(false);
    expect(isAdmissionFailure({ ...spec, admissionFailurePatterns: [] }, res)).toBe(false);
  });
});
