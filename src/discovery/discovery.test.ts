import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdapterSpec } from "../adapters/types.ts";
import { openStore } from "../store/store.ts";
import {
  activeDiscoveredSpecs,
  adapterSpecJsonSchema,
  approveDiscovered,
  canaryDiscovered,
  detectDiscovered,
  discoveryBrief,
  formatReview,
  getDiscovered,
  rejectDiscovered,
  reviewDiscovered,
  submitSpec,
  validateSpec,
  type CanaryExec,
} from "./discovery.ts";
import { CANARY_TOKEN } from "./types.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-agent.ts");

function workspace(): { db: Database; binary: string } {
  const dir = mkdtempSync(join(tmpdir(), "baton-discovery-"));
  // An absolute, executable "agent CLI" of our own: the spec must name one, and
  // the canary spawns exactly the path it names.
  const binary = join(dir, "fake-agent");
  writeFileSync(binary, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} "$@"\n`);
  chmodSync(binary, 0o755);
  return { db: openStore(join(dir, "baton.db")), binary };
}

function spec(binary: string, overrides: Partial<AdapterSpec> = {}): AdapterSpec {
  return {
    app: "fake-agent",
    adapterVersion: 1,
    binary,
    identityEnv: "FAKE_AGENT_HOME",
    models: [{ model: "fake-model", slug: "fake/slug" }],
    invoke: {
      argv: ["run", "--json", "-m", "{slug}", "{autonomyFlags}"],
      promptVia: "stdin",
      extract: { kind: "json", path: "result" },
    },
    autonomyFlags: { readonly: ["--readonly"], full: [] },
    defaultAutonomy: "full",
    defaultTimeoutMs: 60_000,
    admissionFailurePatterns: ["rate limit reached"],
    workStartedPatterns: ['"tool_use"'],
    ...overrides,
  };
}

/** Env that makes the fixture behave; everything else is inherited. */
function env(mode: string, version?: string): Record<string, string | undefined> {
  return {
    ...process.env,
    BATON_FAKE_AGENT_MODE: mode,
    ...(version ? { BATON_FAKE_AGENT_VERSION: version } : {}),
  };
}

const never: CanaryExec = () => {
  throw new Error("executed a spec that was never approved");
};

describe("validateSpec", () => {
  test("accepts a well-formed spec", () => {
    const result = validateSpec(spec("/usr/local/bin/fake-agent"));
    expect(result.ok).toBe(true);
  });

  test("rejects a relative binary", () => {
    const result = validateSpec(spec("./fake-agent"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toContain("binary: must be an absolute path");
  });

  test("rejects shell metacharacters in argv and in autonomy flags", () => {
    const injected = validateSpec(
      spec("/bin/fake", {
        invoke: {
          argv: ["run", "-m", "{slug}", "; rm -rf ~"],
          promptVia: "stdin",
          extract: { kind: "text" },
        },
      }),
    );
    expect(injected.ok).toBe(false);
    if (!injected.ok) expect(injected.errors.join("\n")).toContain("shell metacharacters");

    const inFlags = validateSpec(
      spec("/bin/fake", { autonomyFlags: { full: ["--yolo `whoami`"] } }),
    );
    expect(inFlags.ok).toBe(false);
    if (!inFlags.ok) expect(inFlags.errors.join("\n")).toContain("autonomyFlags.full");
  });

  test("requires {slug} exactly once", () => {
    const missing = validateSpec(
      spec("/bin/fake", {
        invoke: { argv: ["run"], promptVia: "stdin", extract: { kind: "text" } },
      }),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.join("\n")).toContain("{slug} exactly once, found 0");

    const twice = validateSpec(
      spec("/bin/fake", {
        invoke: { argv: ["-m", "{slug}", "--also={slug}"], promptVia: "stdin", extract: { kind: "text" } },
      }),
    );
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.errors.join("\n")).toContain("found 2");
  });

  test("allows {prompt} only when promptVia is argv", () => {
    const onStdin = validateSpec(
      spec("/bin/fake", {
        invoke: { argv: ["-m", "{slug}", "{prompt}"], promptVia: "stdin", extract: { kind: "text" } },
      }),
    );
    expect(onStdin.ok).toBe(false);
    if (!onStdin.ok) expect(onStdin.errors.join("\n")).toContain("only allowed when promptVia is 'argv'");

    const viaArgv = validateSpec(
      spec("/bin/fake", {
        invoke: { argv: ["-m", "{slug}", "{prompt}"], promptVia: "argv", extract: { kind: "text" } },
      }),
    );
    expect(viaArgv.ok).toBe(true);

    const missing = validateSpec(
      spec("/bin/fake", {
        invoke: { argv: ["-m", "{slug}"], promptVia: "argv", extract: { kind: "text" } },
      }),
    );
    expect(missing.ok).toBe(false);
  });

  test("rejects a defaultAutonomy with no flags, duplicate models, and empty models", () => {
    const unsupported = validateSpec(
      spec("/bin/fake", { autonomyFlags: { readonly: [] }, defaultAutonomy: "full" }),
    );
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.errors.join("\n")).toContain("defaultAutonomy");

    const dupes = validateSpec(
      spec("/bin/fake", {
        models: [
          { model: "fake-model", slug: "a" },
          { model: "fake-model", slug: "b" },
        ],
      }),
    );
    expect(dupes.ok).toBe(false);
    if (!dupes.ok) expect(dupes.errors.join("\n")).toContain("duplicate canonical model");

    expect(validateSpec(spec("/bin/fake", { models: [] })).ok).toBe(false);
  });

  test("rejects a built-in app id but allows a built-in model through a new app", () => {
    const collision = validateSpec(spec("/bin/fake", { app: "codex" }));
    expect(collision.ok).toBe(false);
    if (!collision.ok) expect(collision.errors.join("\n")).toContain("built-in adapter");

    // Same model, new route: that is the point of discovery.
    expect(validateSpec(spec("/bin/fake", { models: [{ model: "gpt-5.6-sol", slug: "sol" }] })).ok).toBe(
      true,
    );
  });

  test("a resume template needs {sessionRef} once and something to fill it", () => {
    const sessionRef = { kind: "jsonl", path: "session_id", take: "first" } as const;
    expect(
      validateSpec(spec("/bin/fake", { sessionRef, resume: { argv: ["resume", "{sessionRef}"] } })).ok,
    ).toBe(true);

    const noHandle = validateSpec(spec("/bin/fake", { sessionRef, resume: { argv: ["resume"] } }));
    expect(noHandle.ok).toBe(false);
    if (!noHandle.ok) expect(noHandle.errors.join("\n")).toContain("{sessionRef} exactly once");

    const unfillable = validateSpec(spec("/bin/fake", { resume: { argv: ["resume", "{sessionRef}"] } }));
    expect(unfillable.ok).toBe(false);
    if (!unfillable.ok) expect(unfillable.errors.join("\n")).toContain("without sessionRef");
  });

  test("rejects malformed extraction, patterns and unknown keys", () => {
    expect(validateSpec(spec("/bin/fake", { admissionFailurePatterns: ["  "] })).ok).toBe(false);
    expect(
      validateSpec(
        spec("/bin/fake", {
          invoke: {
            argv: ["-m", "{slug}"],
            promptVia: "stdin",
            extract: { kind: "jsonl", path: "", take: "last" },
          },
        }),
      ).ok,
    ).toBe(false);
    expect(validateSpec({ ...spec("/bin/fake"), surprise: true }).ok).toBe(false);
    expect(validateSpec("not a spec").ok).toBe(false);
  });

  test("reports every structural problem at once, with the offending value", () => {
    const result = validateSpec(spec("fake", { invoke: { argv: ["go"], promptVia: "stdin", extract: { kind: "text" } } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    expect(result.errors.join("\n")).toContain('"fake"');
  });
});

describe("quarantine flow", () => {
  test("submit → review → approve → canary → active", async () => {
    const { db, binary } = workspace();
    const submitted = submitSpec(db, spec(binary));
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.record.status).toBe("quarantined");
    // Quarantined specs are invisible to the registry.
    expect(activeDiscoveredSpecs(db)).toEqual([]);

    const review = reviewDiscovered(db, "fake-agent");
    expect(review?.needsApproval).toBe(true);
    expect(review?.binary).toBe(binary);
    expect(review?.argv).toEqual(["run", "--json", "-m", "{slug}", "{autonomyFlags}"]);
    expect(review?.envNames).toEqual(["FAKE_AGENT_HOME"]);
    const printed = formatReview(review!);
    expect(printed).toContain(binary);
    expect(printed).toContain("FAKE_AGENT_HOME");
    expect(printed).toContain('JSON stdout, path "result"');

    expect(approveDiscovered(db, "fake-agent").ok).toBe(true);
    expect(getDiscovered(db, "fake-agent")?.status).toBe("approved");
    // Approved is not yet runnable: the canary has to prove extraction first.
    expect(activeDiscoveredSpecs(db)).toEqual([]);

    const canary = await canaryDiscovered(db, "fake-agent", undefined, {
      env: env("echo"),
      timeoutMs: 20_000,
    });
    expect(canary.ok).toBe(true);
    if (!canary.ok) return;
    expect(canary.output).toContain(CANARY_TOKEN);
    expect(canary.record.status).toBe("active");
    expect(canary.record.binaryVersion).toBe("fake-agent 1.0.0");
    expect(activeDiscoveredSpecs(db).map((s) => s.app)).toEqual(["fake-agent"]);
  }, 30_000);

  test("the canary asks the declared binary at the least authority it supports", async () => {
    const { db, binary } = workspace();
    submitSpec(db, spec(binary));
    approveDiscovered(db, "fake-agent");
    const seen: { binaryPath?: string; autonomy?: string; prompt?: string } = {};
    const spy: CanaryExec = async (req) => {
      seen.binaryPath = req.binaryPath;
      seen.autonomy = req.autonomy;
      seen.prompt = req.prompt;
      return { ok: true, started: true, output: CANARY_TOKEN, exitCode: 0, timedOut: false, rawTail: "", durationMs: 1 };
    };
    const result = await canaryDiscovered(db, "fake-agent", spy, { probeVersion: () => "v9" });
    expect(result.ok).toBe(true);
    expect(seen.binaryPath).toBe(binary);
    expect(seen.autonomy).toBe("readonly");
    expect(seen.prompt).toContain(CANARY_TOKEN);
  });
});

describe("approval precedes execution", () => {
  test("a quarantined spec is never executed", async () => {
    const { db, binary } = workspace();
    submitSpec(db, spec(binary));
    const result = await canaryDiscovered(db, "fake-agent", never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toContain("approval precedes execution");
    expect(getDiscovered(db, "fake-agent")?.status).toBe("quarantined");
  });

  test("a rejected spec is never executed, and rejection pulls an active adapter", async () => {
    const { db, binary } = workspace();
    submitSpec(db, spec(binary));
    approveDiscovered(db, "fake-agent");
    await canaryDiscovered(db, "fake-agent", undefined, { env: env("echo"), timeoutMs: 20_000 });
    expect(activeDiscoveredSpecs(db)).toHaveLength(1);

    expect(rejectDiscovered(db, "fake-agent", "argv looks wrong").ok).toBe(true);
    expect(getDiscovered(db, "fake-agent")?.notes).toBe("argv looks wrong");
    expect(activeDiscoveredSpecs(db)).toEqual([]);
    const result = await canaryDiscovered(db, "fake-agent", never);
    expect(result.ok).toBe(false);
  }, 30_000);

  test("canary on an unknown app refuses", async () => {
    const { db } = workspace();
    const result = await canaryDiscovered(db, "ghost", never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain("no discovered adapter");
  });

  test("a changed spec goes back to quarantine and out of the registry", async () => {
    const { db, binary } = workspace();
    submitSpec(db, spec(binary));
    approveDiscovered(db, "fake-agent");
    await canaryDiscovered(db, "fake-agent", undefined, { env: env("echo"), timeoutMs: 20_000 });
    expect(getDiscovered(db, "fake-agent")?.status).toBe("active");

    const resubmitted = submitSpec(db, spec(binary, { adapterVersion: 2, invoke: {
      argv: ["run", "--json", "-m", "{slug}", "--new-flag", "{autonomyFlags}"],
      promptVia: "stdin",
      extract: { kind: "json", path: "result" },
    } }));
    expect(resubmitted.ok).toBe(true);
    if (!resubmitted.ok) return;
    expect(resubmitted.record.status).toBe("quarantined");
    expect(resubmitted.record.binaryVersion).toBeUndefined();
    expect(resubmitted.record.reviewedAt).toBeUndefined();
    expect(activeDiscoveredSpecs(db)).toEqual([]);
    expect((await canaryDiscovered(db, "fake-agent", never)).ok).toBe(false);
  }, 30_000);

  test("an invalid submission changes nothing", () => {
    const { db, binary } = workspace();
    submitSpec(db, spec(binary));
    const bad = submitSpec(db, spec(binary, { binary: "fake-agent" }));
    expect(bad.ok).toBe(false);
    expect(getDiscovered(db, "fake-agent")?.spec.binary).toBe(binary);
  });
});

describe("canary failure", () => {
  test("a wrong answer keeps the adapter approved, with the reason", async () => {
    const { db, binary } = workspace();
    submitSpec(db, spec(binary));
    approveDiscovered(db, "fake-agent");
    const result = await canaryDiscovered(db, "fake-agent", undefined, {
      env: env("wrong"),
      timeoutMs: 20_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const record = getDiscovered(db, "fake-agent");
    expect(record?.status).toBe("approved");
    expect(record?.notes).toContain("canary failed");
    expect(record?.binaryVersion).toBeUndefined();
    expect(activeDiscoveredSpecs(db)).toEqual([]);
  }, 30_000);

  test("a failing CLI keeps the adapter approved, with the exit reported", async () => {
    const { db, binary } = workspace();
    submitSpec(db, spec(binary));
    approveDiscovered(db, "fake-agent");
    const result = await canaryDiscovered(db, "fake-agent", undefined, {
      env: env("fail"),
      timeoutMs: 20_000,
    });
    expect(result.ok).toBe(false);
    expect(getDiscovered(db, "fake-agent")?.status).toBe("approved");
    expect(getDiscovered(db, "fake-agent")?.notes).toContain("rate limit reached");
  }, 30_000);
});

describe("detectDiscovered", () => {
  async function activated(): Promise<{ db: Database; binary: string }> {
    const { db, binary } = workspace();
    submitSpec(db, spec(binary));
    approveDiscovered(db, "fake-agent");
    await canaryDiscovered(db, "fake-agent", undefined, { env: env("echo"), timeoutMs: 20_000 });
    return { db, binary };
  }

  test("a version bump marks the adapter stale until it re-canaries", async () => {
    const { db } = await activated();
    expect(detectDiscovered(db, { probeVersion: () => "fake-agent 1.0.0" })).toEqual([]);

    const changes = detectDiscovered(db, { probeVersion: () => "fake-agent 2.0.0" });
    expect(changes).toHaveLength(1);
    expect(changes[0]?.to).toBe("stale");
    expect(changes[0]?.note).toContain("fake-agent 1.0.0 → fake-agent 2.0.0");
    expect(activeDiscoveredSpecs(db)).toEqual([]);

    // Stale re-canaries the ALREADY APPROVED spec — no second review.
    const recanary = await canaryDiscovered(db, "fake-agent", undefined, {
      env: env("echo", "fake-agent 2.0.0"),
      timeoutMs: 20_000,
      probeVersion: () => "fake-agent 2.0.0",
    });
    expect(recanary.ok).toBe(true);
    if (!recanary.ok) return;
    expect(recanary.record.status).toBe("active");
    expect(recanary.record.binaryVersion).toBe("fake-agent 2.0.0");
    expect(detectDiscovered(db, { probeVersion: () => "fake-agent 2.0.0" })).toEqual([]);
  }, 30_000);

  test("an unprobeable binary is not evidence of a change", async () => {
    const { db } = await activated();
    expect(detectDiscovered(db, { probeVersion: () => undefined })).toEqual([]);
    expect(getDiscovered(db, "fake-agent")?.status).toBe("active");
  }, 30_000);

  test("non-active adapters are left alone", () => {
    const { db, binary } = workspace();
    submitSpec(db, spec(binary));
    expect(detectDiscovered(db, { probeVersion: () => "anything" })).toEqual([]);
    expect(getDiscovered(db, "fake-agent")?.status).toBe("quarantined");
  });
});

describe("discoveryBrief", () => {
  const brief = discoveryBrief("newcli");

  test("names the app and warns that CLI output is untrusted", () => {
    expect(brief).toContain("newcli");
    expect(brief).toContain("UNTRUSTED");
  });

  test("covers the probe checklist", () => {
    for (const item of [
      "which -a",
      "Non-interactive invocation",
      "Structured output",
      "Model slugs",
      "Resume",
      "Auth state",
      "Identity env var",
      "Permission flags",
      "Admission-failure evidence",
      "Work-started evidence",
    ]) {
      expect(brief).toContain(item);
    }
  });

  test("embeds the adapter-spec JSON Schema and the quarantine flow", () => {
    const schema = adapterSpecJsonSchema();
    expect(brief).toContain(JSON.stringify(schema, null, 2));
    expect(brief).toContain("QUARANTINED");
    expect(brief).toContain(CANARY_TOKEN);
    const properties = Object.keys(schema.properties as Record<string, unknown>);
    // Every field an adapter can declare has to be describable, or the agent
    // cannot express what it probed.
    for (const field of [
      "adapterVersion",
      "admissionFailurePatterns",
      "app",
      "autonomyFlags",
      "binary",
      "defaultAutonomy",
      "defaultTimeoutMs",
      "identityEnv",
      "invoke",
      "models",
      "sessionRef",
      "workStartedPatterns",
    ]) {
      expect(properties).toContain(field);
    }
  });
});
