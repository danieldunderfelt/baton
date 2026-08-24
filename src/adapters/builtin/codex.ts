import type { AdapterSpec } from "../types.ts";

/**
 * codex-cli 0.149.0 (probed live on this machine).
 *
 * Notes that are not obvious from the flags:
 * - `--skip-git-repo-check` is mandatory: without it, any cwd that is not a git
 *   repo fails before the model is reached ("Not inside a trusted directory"),
 *   with empty stdout and no way to answer the prompt non-interactively.
 * - No PROMPT argument is passed: `codex exec` reads instructions from stdin
 *   when the positional is absent. Passing both would append stdin as a
 *   separate `<stdin>` block instead of using it as the prompt.
 * - Every run on this machine emits an `item.completed` whose `item.type` is
 *   "error" (local skill-budget noise). Filtering on `item.type ==
 *   "agent_message"` skips it; `take: "last"` guards against future
 *   intermediate agent messages.
 * - The working root is the spawned process cwd (codex `-C` defaults to it).
 */
export const codexAdapter: AdapterSpec = {
  app: "codex",
  adapterVersion: 1,
  binary: "codex",
  identityEnv: "CODEX_HOME",
  models: [
    { model: "gpt-5.6-sol", slug: "gpt-5.6-sol" },
    { model: "gpt-5.6-luna", slug: "gpt-5.6-luna" },
  ],
  invoke: {
    argv: ["exec", "--json", "--skip-git-repo-check", "-m", "{slug}", "{autonomyFlags}"],
    promptVia: "stdin",
    extract: {
      kind: "jsonl",
      where: { path: "item.type", equals: "agent_message" },
      // A turn that ends in "turn.failed" produced no answer, whatever text it
      // streamed first; exit codes alone were the only guard before.
      errorWhen: { path: "type", equals: "turn.failed" },
      path: "item.text",
      take: "last",
    },
  },
  // First stdout line of every exec: {"type":"thread.started","thread_id":"<uuid>"}.
  sessionRef: {
    kind: "jsonl",
    where: { path: "type", equals: "thread.started" },
    path: "thread_id",
    take: "first",
  },
  autonomyFlags: {
    readonly: ["-s", "read-only"],
    edits: ["-s", "workspace-write", "--approve-for-me"],
    full: ["--dangerously-bypass-approvals-and-sandbox"],
  },
  defaultAutonomy: "full",
  defaultTimeoutMs: 300_000,
  // Auth rejection before the turn starts: 401 on both the wss:// and https://
  // transports, retried 5x each. Deliberately excludes "turn.failed" (emitted
  // for any failure, including a bad model slug) so pool cooldown stays
  // reserved for admission failures.
  admissionFailurePatterns: [
    "unexpected status 401 Unauthorized",
    "Missing bearer or basic authentication in header",
  ],
  // The turn envelope and any completed item: both prove the exec got past
  // admission and into the model's turn. If codex prints "turn.started" before
  // the transport is even tried, a genuine pre-work 401 will read as a plain
  // failure instead of an admission one — the deliberate direction to err in,
  // since the other way replays a prompt that may already have edited files.
  workStartedPatterns: ['"turn.started"', '"type":"item.completed"'],
};
