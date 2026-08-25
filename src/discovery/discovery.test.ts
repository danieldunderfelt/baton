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
  shortDigest,
  specDigest,
  submitSpec,
  validateSpec,
  type CanaryExec,
  type Stored,
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

/**
 * Approval as a human gives it: quoting the digest of the spec that is stored
 * right now, which is what `baton adapters review` printed.
 */
function approve(db: Database, app = "fake-agent"): Stored {
  const record = getDiscovered(db, app);
  return approveDiscovered(db, app, { digest: shortDigest(record?.digest ?? "") });
}

/** An exec that answers the canary correctly, without spawning anything. */
function answers(output: string): CanaryExec {
  return async () => ({
    ok: true,
    started: true,
    output,
    exitCode: 0,
    timedOut: false,
    rawTail: "",
    durationMs: 1,
  });
}

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

  test("rejects control, escape and bidi characters in every string field", () => {
    // The review is read in a terminal: ESC[2J erases the screen the human is
    // about to read, and a right-to-left override reorders the line it sits on.
    const inArgv = validateSpec(
      spec("/bin/fake", {
        invoke: {
          argv: ["run", "-m", "{slug}", "--quiet\u001b[2J"],
          promptVia: "stdin",
          extract: { kind: "text" },
        },
      }),
    );
    expect(inArgv.ok).toBe(false);
    if (!inArgv.ok) {
      const errors = inArgv.errors.join("\n");
      expect(errors).toContain("invoke.argv.3");
      expect(errors).toContain("control, bidi or zero-width");
      // The offending value is reported escaped, never echoed back raw.
      expect(errors).not.toContain("\u001b");
      expect(errors).toContain("\\u001b");
    }

    // Every string field, not just argv: a slug, the binary path, a failure
    // pattern, an autonomy fragment and the resume template all reach the eye.
    for (const overrides of [
      { models: [{ model: "fake-model", slug: "fake/slug\u202e" }] },
      { binary: "/bin/fake\u0007" },
      { admissionFailurePatterns: ["rate limit\u009b reached"] },
      {
        autonomyFlags: { readonly: ["--read\u200bonly"] },
        defaultAutonomy: "readonly" as const,
      },
      {
        sessionRef: { kind: "jsonl", path: "session_id", take: "first" } as const,
        resume: { argv: ["resume", "\u2066--key", "{sessionRef}"] },
      },
    ]) {
      expect(validateSpec(spec("/bin/fake", overrides)).ok).toBe(false);
    }
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

    expect(approve(db).ok).toBe(true);
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
    approve(db);
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

  test("the canary demands the token exactly, not the token somewhere", async () => {
    const { db, binary } = workspace();
    submitSpec(db, spec(binary));
    approve(db);
    // An adapter whose extraction returns the whole transcript "contains" the
    // token — and has proved nothing about the declared extraction path.
    const chatty = await canaryDiscovered(db, "fake-agent", answers(`Sure! ${CANARY_TOKEN}, done.`), {
      probeVersion: () => "v9",
    });
    expect(chatty.ok).toBe(false);
    if (chatty.ok) return;
    expect(chatty.errors.join("\n")).toContain("instead of");
    expect(getDiscovered(db, "fake-agent")?.status).toBe("approved");
    expect(activeDiscoveredSpecs(db)).toEqual([]);

    // Surrounding whitespace is the CLI's, not the model's.
    const exact = await canaryDiscovered(db, "fake-agent", answers(`\n${CANARY_TOKEN}\n`), {
      probeVersion: () => "v9",
    });
    expect(exact.ok).toBe(true);
  });
});

describe("the spec digest is the unit of consent", () => {
  test("it follows content, not key order or app name", () => {
    const a = spec("/bin/fake");
    // Same fields, different key order — one spec, one digest.
    const reordered = Object.fromEntries(
      Object.entries(a).reverse(),
    ) as unknown as AdapterSpec;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(a));
    expect(specDigest(reordered)).toBe(specDigest(a));
    expect(specDigest(spec("/bin/fake", { adapterVersion: 2 }))).not.toBe(specDigest(a));
  });

  test("approval must quote the digest of the spec that is stored", () => {
    const { db, binary } = workspace();
    const submitted = submitSpec(db, spec(binary));
    expect(submitted.ok && submitted.record.digest).toBe(specDigest(spec(binary)));

    const guessed = approveDiscovered(db, "fake-agent", { digest: "0".repeat(12) });
    expect(guessed.ok).toBe(false);
    if (!guessed.ok) expect(guessed.errors.join("\n")).toContain("digest mismatch");
    expect(getDiscovered(db, "fake-agent")?.status).toBe("quarantined");

    // A prefix shorter than the review prints is not a digest, it is a guess.
    expect(approveDiscovered(db, "fake-agent", { digest: "ab" }).ok).toBe(false);
    expect(approve(db).ok).toBe(true);
    expect(getDiscovered(db, "fake-agent")?.status).toBe("approved");
  });

  test("approval quoting a digest that was just replaced is refused", () => {
    const { db, binary } = workspace();
    submitSpec(db, spec(binary));
    const reviewed = shortDigest(getDiscovered(db, "fake-agent")!.digest);
    // The human read S1; the agent submitted S2 before they hit enter.
    submitSpec(db, spec(binary, { adapterVersion: 7 }));

    const approved = approveDiscovered(db, "fake-agent", { digest: reviewed });
    expect(approved.ok).toBe(false);
    if (!approved.ok) expect(approved.errors.join("\n")).toContain("not approving what you reviewed");
    expect(getDiscovered(db, "fake-agent")?.status).toBe("quarantined");
  });

  test("a canary that outlived its spec activates nothing (the reproduced race)", async () => {
    const { db, binary } = workspace();
    submitSpec(db, spec(binary)); // S1
    expect(approve(db).ok).toBe(true);

    // S1's canary is in flight...
    let release = (): void => {};
    const inFlight = new Promise<void>((resolve) => (release = resolve));
    const slow: CanaryExec = async (req) => {
      await inFlight;
      return answers(CANARY_TOKEN)(req);
    };
    const running = canaryDiscovered(db, "fake-agent", slow, { probeVersion: () => "v1" });

    // ...when the agent submits S2, which nobody has reviewed.
    const s2 = spec(binary, {
      adapterVersion: 2,
      invoke: {
        argv: ["run", "--json", "-m", "{slug}", "--dangerously-skip-permissions", "{autonomyFlags}"],
        promptVia: "stdin",
        extract: { kind: "json", path: "result" },
      },
    });
    const resubmitted = submitSpec(db, s2);
    expect(resubmitted.ok && resubmitted.record.status).toBe("quarantined");

    release();
    const result = await running;

    // S1's token came back — and it says nothing about S2.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toContain("discarded");
    const stored = getDiscovered(db, "fake-agent");
    expect(stored?.status).toBe("quarantined");
    expect(stored?.digest).toBe(specDigest(s2));
    expect(activeDiscoveredSpecs(db)).toEqual([]);
  });

  test("a canary that outlived its spec activates nothing even once the status comes back", async () => {
    // The race above is caught by the status having moved. This is the same
    // race with the status restored, so only the CONTENT says the spec changed:
    // without the spec precondition, S1's token would activate S2 — a spec
    // nothing has ever executed, which is the whole point of the canary.
    const { db, binary } = workspace();
    submitSpec(db, spec(binary)); // S1
    expect(approve(db).ok).toBe(true);

    let release = (): void => {};
    const inFlight = new Promise<void>((resolve) => (release = resolve));
    const slow: CanaryExec = async (req) => {
      await inFlight;
      return answers(CANARY_TOKEN)(req);
    };
    const running = canaryDiscovered(db, "fake-agent", slow, { probeVersion: () => "v1" });

    // The agent resubmits S2 — which quarantines the row — and the user, who
    // has been reading it all along, approves S2 as well. The status the canary
    // launched under is now back.
    const s2 = spec(binary, { adapterVersion: 2 });
    submitSpec(db, s2);
    expect(approve(db).ok).toBe(true);
    expect(getDiscovered(db, "fake-agent")?.status).toBe("approved");

    release();
    const result = await running;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toContain("discarded");
    const stored = getDiscovered(db, "fake-agent");
    // Approved, because the user really did approve S2 — and still not active,
    // because approval is consent to run it, not evidence that it works.
    expect(stored?.status).toBe("approved");
    expect(stored?.digest).toBe(specDigest(s2));
    expect(activeDiscoveredSpecs(db)).toEqual([]);
  });

  test("a failing canary that outlived its spec writes no note onto the new one", async () => {
    const { db, binary } = workspace();
    submitSpec(db, spec(binary));
    approve(db);
    let release = (): void => {};
    const inFlight = new Promise<void>((resolve) => (release = resolve));
    const slow: CanaryExec = async (req) => {
      await inFlight;
      return answers("nothing like the token")(req);
    };
    const running = canaryDiscovered(db, "fake-agent", slow);
    submitSpec(db, spec(binary, { adapterVersion: 3 }));
    release();

    const result = await running;
    expect(result.ok).toBe(false);
    const stored = getDiscovered(db, "fake-agent");
    expect(stored?.status).toBe("quarantined");
    expect(stored?.notes).toBeUndefined();
  });

  test("rejection is not digest-bound: it only ever takes rights away", () => {
    const { db, binary } = workspace();
    submitSpec(db, spec(binary));
    approve(db);
    submitSpec(db, spec(binary, { adapterVersion: 4 }));

    const rejected = rejectDiscovered(db, "fake-agent", "argv looks wrong");
    expect(rejected.ok).toBe(true);
    expect(getDiscovered(db, "fake-agent")?.status).toBe("rejected");
    expect(activeDiscoveredSpecs(db)).toEqual([]);
  });
});

describe("formatReview", () => {
  test("shows every argv it can spawn as a JSON array, plus the digest", () => {
    const { db, binary } = workspace();
    submitSpec(
      db,
      spec(binary, {
        sessionRef: { kind: "jsonl", path: "session_id", take: "first" },
        resume: { argv: ["run", "--json", "resume", "{sessionRef}", "-m", "{slug}"] },
      }),
    );
    const review = reviewDiscovered(db, "fake-agent")!;
    const printed = formatReview(review);

    // Element boundaries are the review: "--flag value" as ONE element is a
    // different program from two, and joining with spaces hides which it is.
    expect(printed).toContain('["run","--json","-m","{slug}","{autonomyFlags}"]');
    // The resume path spawns a second argv; it was invisible before.
    expect(printed).toContain('["run","--json","resume","{sessionRef}","-m","{slug}"]');
    expect(printed).toContain('JSONL stdout, first record, path "session_id"');
    expect(printed).toContain(shortDigest(review.digest));
    // Every level, including the ones this adapter cannot express.
    expect(printed).toContain("readonly [\"--readonly\"]");
    expect(printed).toContain("edits    unsupported");
    expect(printed).toContain("full     []   (default)");
    expect(printed).toContain('admission:  ["rate limit reached"]');
    expect(printed).toContain('work-start: ["\\"tool_use\\""]');
  });

  test("escapes a stored string that would repaint the terminal", () => {
    const { db, binary } = workspace();
    submitSpec(db, spec(binary));
    const review = reviewDiscovered(db, "fake-agent")!;
    // Validation keeps these out at submit; a row written by an older Baton (or
    // by hand) still has to print harmlessly.
    const printed = formatReview({ ...review, binary: `${binary}\u001b[2J` });
    expect(printed).not.toContain("\u001b");
    expect(printed).toContain("\\u001b[2J");
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
    approve(db);
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
    approve(db);
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
    approve(db);
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
    approve(db);
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
    approve(db);
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
