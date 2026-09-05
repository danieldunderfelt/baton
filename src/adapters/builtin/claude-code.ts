import type { AdapterSpec } from "../types.ts";

/**
 * Claude Code 2.1.241 (probed live on this machine).
 *
 * Notes that are not obvious from the flags:
 * - The binary is the bare name on purpose: detect resolves it with `Bun.which`
 *   and the executor spawns that absolute path with no shell, so the user's
 *   `claude` shell alias (which silently appends
 *   `--dangerously-skip-permissions`) never applies here. Autonomy must be
 *   stated explicitly — which is what `autonomyFlags` does.
 * - `--output-format json` prints one JSON object with the answer in `result`;
 *   `stream-json` only adds parsing work for a one-shot delegation.
 * - `-p` with no positional prompt reads the prompt from stdin (verified).
 * - Session persistence is deliberately left on: `session_id` is what phase-2
 *   session affinity resumes with (`--resume`), so `--no-session-persistence`
 *   would trade resumability for nothing.
 * - There is no command that lists models. `--model` takes an alias for the
 *   latest model of a family (`fable`, `opus`, `sonnet`, `haiku`) or a full
 *   model id (`claude-fable-5`), so the aliases are pinned and any `claude-*`
 *   id is accepted as-is; the CLI is what rejects an id it does not know.
 * - haiku is a supported slug but is intentionally not routed here.
 * - Failures still print valid JSON on stdout while exiting 1: auth rejection
 *   has `api_error_status: null`, an unknown model slug has 404. The executor
 *   reports the non-zero exit, and the JSON body reaches the admission match
 *   through `rawTail`.
 */
export const claudeCodeAdapter: AdapterSpec = {
  app: "claude-code",
  adapterVersion: 1,
  binary: "claude",
  identityEnv: "CLAUDE_CONFIG_DIR",
  models: [
    { model: "fable-5.1", slug: "fable" },
    { model: "opus-5", slug: "opus" },
    { model: "sonnet-5", slug: "sonnet" },
  ],
  acceptsSlugs: ["claude-*"],
  invoke: {
    argv: ["-p", "--output-format", "json", "--model", "{slug}", "{autonomyFlags}"],
    promptVia: "stdin",
    extract: { kind: "json", path: "result" },
  },
  // Same single JSON object: {"session_id":"<uuid>", ...}. Resumable with
  // `--resume <session_id>` from the same instance.
  sessionRef: { kind: "json", path: "session_id" },
  // `-r, --resume [value]` on the same command as `-p`, so every invoke flag
  // stays valid (verified against `claude --help`; not exercised live — the
  // resume canary is codex-only, see builtin.test.ts). The session id goes
  // immediately after `-r`: its value is optional, and an absent one opens the
  // interactive picker. `--fork-session` is deliberately not passed, so the
  // resumed session keeps its id and can be resumed again.
  resume: {
    argv: [
      "-p",
      "--output-format",
      "json",
      "-r",
      "{sessionRef}",
      "--model",
      "{slug}",
      "{autonomyFlags}",
    ],
  },
  // One flag family covers all three levels, so a scope ceiling maps cleanly.
  // `plan` is the read-only mode (it may read, never write); `acceptEdits`
  // auto-approves edits without granting the rest. Unlike kimi, `-p` accepts
  // every mode — all three verified live against sonnet.
  autonomyFlags: {
    readonly: ["--permission-mode", "plan"],
    edits: ["--permission-mode", "acceptEdits"],
    full: ["--permission-mode", "bypassPermissions"],
  },
  defaultAutonomy: "full",
  defaultTimeoutMs: 300_000,
  // "Not logged in" is the verified admission failure (reproduced by pointing
  // CLAUDE_CONFIG_DIR at an empty dir), and the only one listed. Deliberately
  // excludes:
  // - the model-not-found body ("There's an issue with the selected model"),
  //   a route defect rather than an instance one;
  // - "usage limit reached", which was inferred, never observed, and is exactly
  //   the string a long run prints AFTER editing files — matching it would make
  //   the supervisor replay the prompt on another account and duplicate those
  //   edits. Re-verify against a real exhausted window before listing it, and
  //   only together with a work-started marker below.
  admissionFailurePatterns: ["Not logged in"],
  // Empty on purpose. `-p --output-format json` prints the same single result
  // envelope whether it worked or was refused at the door, so no substring of
  // it distinguishes "started" from "never admitted" (total_cost_usd is present
  // either way and a substring match cannot read it as a number). The safety
  // here comes from the pruned list above: "Not logged in" cannot appear as the
  // outcome of a session that was already running.
  workStartedPatterns: [],
};
