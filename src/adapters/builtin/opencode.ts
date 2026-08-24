import type { AdapterSpec } from "../types.ts";

/**
 * opencode 1.18.22 (probed live on this machine).
 *
 * Notes that are not obvious from the flags:
 * - `--format json` is required: the default formatted mode prints ANSI text
 *   and never prints the session id.
 * - The prompt is the `run` positional; there is no stdin prompt mode.
 * - No `identityEnv`: credentials live at a fixed `~/.local/share/opencode/
 *   auth.json`. `OPENCODE_CONFIG_DIR` (which PLAN.md assumed) does not exist,
 *   and `XDG_*`/`HOME` overrides did not move the credential store, so opencode
 *   instances can only ever be the inherited-environment `default`. Verified by
 *   probe, not assumed.
 * - Only `full` is declared. `opencode run` is already non-interactive, and
 *   `--auto` is its one permission flag — there is no readonly/edits tier
 *   outside `opencode.json`. As with kimi, declaring the level Baton cannot
 *   constrain as `full` makes a lower ceiling exclude the route instead of
 *   silently running above it.
 * - Exit codes are unreliable in json mode (a live upstream 503 exited 0), so
 *   failure detection rests on the stream: an "error" event fails the run
 *   (`errorWhen`) even when text parts preceded it, and the event survives in
 *   `rawTail` for the admission match.
 */
export const opencodeAdapter: AdapterSpec = {
  app: "opencode",
  adapterVersion: 1,
  binary: "opencode",
  models: [{ model: "ox-alpha", slug: "opencode/x-preview-f-free" }],
  invoke: {
    argv: ["run", "-m", "{slug}", "--format", "json", "{autonomyFlags}", "{prompt}"],
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
  autonomyFlags: { full: ["--auto"] },
  defaultAutonomy: "full",
  defaultTimeoutMs: 300_000,
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
