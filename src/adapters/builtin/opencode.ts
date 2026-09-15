import type { AdapterSpec } from "../types.ts";

/**
 * opencode 2.0.3 (probed live on this machine).
 *
 * Notes that are not obvious from the flags:
 * - `--format json` is required: the default formatted mode prints ANSI text
 *   and never prints the session id.
 * - The prompt is the `run` positional; there is no stdin prompt mode.
 * - `XDG_DATA_HOME` relocates OpenCode's data root, including its auth.json,
 *   so it is the identity environment for named profiles. The profile overlay
 *   may also set `OPENCODE_CONFIG` and the other XDG roots, but XDG_DATA_HOME
 *   is the required account boundary.
 * - `--standalone` is required for that boundary to hold. Since v2, `run` and
 *   `models` talk to a persistent `opencode serve --service` daemon by default,
 *   and the daemon's auth wins over the caller's environment (verified: an
 *   empty XDG_DATA_HOME still listed every logged-in provider without the
 *   flag, and nothing with it). A private server per run costs a couple of
 *   seconds of startup.
 * - Permissions are config, not flags. `--auto` is the one flag and it only
 *   auto-approves what would otherwise *ask*; an explicit `deny` still holds.
 *   Without `--auto` a non-interactive run auto-rejects every ask and aborts
 *   the step (verified: `external_directory` killed a run with an "aborted"
 *   error event). So every level passes `--auto`, and the lower levels narrow
 *   it with denies in `OPENCODE_CONFIG_CONTENT`, which merges over the user's
 *   opencode.json. Verified live at 2.0.3: `edit: deny` removes write/edit
 *   from the toolset, `bash: deny` removes the `shell` tool (v2's name for
 *   it), and the model reports having neither. `OPENCODE_PERMISSION`, the
 *   documented inline-permission variable, is ignored in 2.0.3 — a write went
 *   through with it set — so it is not relied on.
 * - Exit codes are unreliable in json mode (a live upstream 503 exited 0), so
 *   failure detection rests on the stream: an "error" event fails the run
 *   (`errorWhen`) even when text parts preceded it, and the event survives in
 *   `rawTail` for the admission match.
 */
export const opencodeAdapter: AdapterSpec = {
  app: "opencode",
  cooldownScope: "provider",
  adapterVersion: 1,
  binary: "opencode",
  identityEnv: "XDG_DATA_HOME",
  // OpenCode is a multi-provider host: what it can actually serve depends on
  // which providers this machine has logged in. `opencode models` reports the
  // whole set, one `provider/model` slug per line, and every one of them is a
  // route under that name. The one pinned here is the canonical id Baton's
  // ratings already use. Claude/GPT models also appear via opencode's copilot
  // provider; they route better through their native apps, and a user who
  // wants them out of the way blocks them ('baton block add
  // opencode/github-copilot/*'). glm-5.3-flash is what the opencode/x-preview-f-free
  // preview ("ox-alpha") turned out to be; that slug left the catalog with v2.
  models: [
    { model: "muse-spark-1.3", slug: "opencode/muse-spark-1.3-contributor-free" },
    { model: "glm-5.3-flash", slug: "zai-coding-plan/glm-5.3-flash" },
  ],
  listModels: { argv: ["models", "--standalone"], extract: { kind: "lines" } },
  invoke: {
    argv: [
      "run",
      "--standalone",
      "-m",
      "{slug}",
      "--format",
      "json",
      "{autonomyFlags}",
      "{prompt}",
    ],
    promptVia: "argv",
    // One "text" event per message part, each carrying that part's whole text
    // (verified: a five-line answer arrived as a single event, not per token).
    // A run that used tools emits a text part per step, so the answer is the
    // last one.
    extract: {
      kind: "jsonl",
      where: { path: "type", equals: "text" },
      // Exit codes are useless here (a live 503 exited 0) and a run can stream
      // several text parts and *then* fail, so the error event has to dominate
      // rather than lose to the last text part.
      errorWhen: { path: "type", equals: "error" },
      path: "part.text",
      take: "last",
    },
  },
  // Every event line — including error events — carries the same top-level
  // sessionID, so no filter is needed. Resume via `--session <id>`.
  sessionRef: { kind: "jsonl", path: "sessionID", take: "first" },
  // `-s, --session <id>` on `opencode run` itself (verified against
  // `opencode run --help`; not exercised live — the resume canary is
  // codex-only). `--fork` is not passed: the continued session keeps its id,
  // which is the id every event line already carries.
  resume: {
    argv: [
      "run",
      "--standalone",
      "-m",
      "{slug}",
      "--format",
      "json",
      "-s",
      "{sessionRef}",
      "{autonomyFlags}",
      "{prompt}",
    ],
  },
  autonomyFlags: { readonly: ["--auto"], edits: ["--auto"], full: ["--auto"] },
  // readonly keeps read/glob/grep/webfetch; edits adds file writes but still no
  // shell, matching claude-code's acceptEdits rather than codex's sandboxed
  // workspace-write, because opencode cannot sandbox a command, only refuse it.
  autonomyEnv: {
    readonly: { OPENCODE_CONFIG_CONTENT: '{"permission":{"edit":"deny","bash":"deny"}}' },
    edits: { OPENCODE_CONFIG_CONTENT: '{"permission":{"bash":"deny"}}' },
  },
  defaultAutonomy: "full",
  // The zen free models need no local credentials, so no auth failure could be
  // reproduced. What was observed live is the APIError envelope of an upstream
  // 503 — a pre-work rejection, which is exactly what cooldown-and-failover is
  // for. The 401/429 status markers are inferred from that same compact-JSON
  // envelope; re-verify against a credentialed provider before trusting them.
  admissionFailurePatterns: ['"statusCode":401', '"statusCode":429', "Upstream request failed"],
  // "Upstream request failed" and a 429 can just as easily arrive on step five
  // of a run that has been editing files, so all three patterns above only mean
  // "refused admission" while the stream is still empty of these markers: the
  // first step of any run, and the first text part of its answer.
  workStartedPatterns: ['"type":"step_start"', '"type":"text"'],
};
