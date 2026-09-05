import type { AdapterSpec } from "../types.ts";

/**
 * cursor-agent 2026.07.23 (probed live on this machine).
 *
 * Notes that are not obvious from the flags:
 * - `-p/--print` is what makes it non-interactive; without it the CLI is a TUI.
 *   With `-p` and no positional prompt it reads the prompt from stdin (verified
 *   live, including on a resumed session), so the prompt never has to survive a
 *   trip through argv.
 * - `--output-format stream-json` over `json`: both end in the same terminal
 *   `result` object, but only the stream shows what happened before it, which is
 *   where the work-started evidence below comes from. `text` mode is ANSI prose.
 * - No `identityEnv`. `--help` exposes only `CURSOR_API_KEY`/`CURSOR_API_ENDPOINT`
 *   — API-key configuration, not a config-dir style identity var. (Relocating
 *   `HOME` does move the credential store, but `HOME` moves *everything* about a
 *   child process; it is not this app's identity var.) So cursor-agent has only
 *   the inherited-environment `default` instance and no pool is possible, same
 *   as opencode — PLAN.md §Instance mechanics excludes both.
 * - Failures do not respect `--output-format`. A bad slug, a bad API key and a
 *   logged-out config all exit 1 with a plain-text line on stderr and no JSON at
 *   all, so nothing here may assume a well-formed envelope on the failure path;
 *   the executor reports the non-zero exit and the text reaches the admission
 *   match through `rawTail`.
 */
export const cursorAdapter: AdapterSpec = {
  app: "cursor-agent",
  adapterVersion: 1,
  binary: "cursor-agent",
  // The pinned id is the high-reasoning route. `cursor-agent models` prints
  // "slug - Display name" per line under an "Available models" header, and
  // every slug there — the other effort levels, the `-fast` variants, the
  // other families — is routable under its own name.
  models: [{ model: "grok-4.6", slug: "cursor-grok-4.6-high" }],
  listModels: { argv: ["models"], extract: { kind: "lines", separator: " - " } },
  invoke: {
    argv: ["-p", "--model", "{slug}", "--output-format", "stream-json", "{autonomyFlags}"],
    promptVia: "stdin",
    // The stream ends with exactly one {"type":"result", ...,"result":"<text>"}
    // — the same object `--output-format json` would print alone. The answer is
    // taken from there rather than from the `assistant` events' content array:
    // it is guaranteed present once, already assembled, and unaffected by tool
    // steps that emit assistant messages of their own.
    extract: {
      kind: "jsonl",
      where: { path: "type", equals: "result" },
      // The result envelope reports failure in `is_error`, not in the exit code
      // (`subtype` is prose); a failed turn must not surrender its `result`
      // string as if it were an answer.
      errorWhen: { path: "is_error", equals: "true" },
      path: "result",
      take: "last",
    },
  },
  // Every event carries the same session_id, starting with the system/init line
  // that is emitted before the model is even called — so it survives runs that
  // died mid-answer, which are the ones worth resuming.
  sessionRef: { kind: "jsonl", path: "session_id", take: "first" },
  // Verified live: a second turn resumed by id recalled the first turn's answer
  // and kept the same session_id. `--continue` (no id) would resume "the most
  // recent session", which is not a handle, so it is not used.
  resume: {
    argv: [
      "--resume",
      "{sessionRef}",
      "-p",
      "--model",
      "{slug}",
      "--output-format",
      "stream-json",
      "{autonomyFlags}",
    ],
  },
  // `--force` (alias `--yolo`) is what makes a run unattended: `-p` alone still
  // has write and shell tools and blocks on approval. `--mode plan` is the
  // read-only ceiling and it holds *above* --force — verified live: asked to
  // create a file with both flags set, the run auto-answered its own approval
  // query, wrote nothing, and returned a plan. No `edits` level is declared:
  // cursor's only middle tier is `--auto-review`, a server-side classifier that
  // decides per tool call, which is not a ceiling Baton can promise a caller.
  autonomyFlags: {
    readonly: ["--mode", "plan", "--force"],
    full: ["--force"],
  },
  defaultAutonomy: "full",
  defaultTimeoutMs: 300_000,
  // Both reproduced live, both plain text on stderr, both structurally
  // startup-only — cursor-agent checks credentials before it opens the stream:
  //   CURSOR_API_KEY rejected  -> "Warning: The provided API key is invalid."
  //   no credentials at all    -> "Error: Authentication required. Please run…"
  // Deliberately excludes:
  // - "Cannot use this model: <slug>", the bad-slug line: a route defect, not an
  //   instance one, and failing over would only reproduce it;
  // - rate-limit/quota text, which was never observed here. Guessing at it would
  //   put an unverified string in the one list that can make the supervisor
  //   replay a prompt on another account.
  admissionFailurePatterns: ["Authentication required", "The provided API key is invalid"],
  // The admission patterns above cannot appear mid-run, so these are not load
  // bearing today; they are declared because failover safety must not depend on
  // that staying true. Anything after the opening system/init event means the
  // request was admitted and the callee is doing things: the prompt echo, a
  // reasoning trace, a tool call, an answer.
  workStartedPatterns: [
    '"type":"user"',
    '"type":"thinking"',
    '"type":"tool_call"',
    '"type":"assistant"',
  ],
};
