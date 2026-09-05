import type { AdapterSpec } from "../types.ts";

/**
 * kimi-code 0.37.2 (probed live on this machine).
 *
 * Notes that are not obvious from the flags:
 * - `--output-format stream-json` is required for clean extraction: text mode
 *   prefixes the answer with "• " and mixes banners/resume hints into stderr.
 * - The prompt goes through `-p`; there is no stdin prompt mode.
 * - Only `full` is listed because `-p` refuses every permission-mode flag
 *   ("Cannot combine --prompt with --yolo/--auto/--plan", verified live), so
 *   non-interactive kimi runs at one fixed, unexpressible authority level.
 *   Declaring it as `full` is the safe direction: a scope whose ceiling is
 *   readonly/edits gets "unsupported" rather than a run at an authority Baton
 *   cannot actually constrain.
 * - Only KIMI_CODE_HOME relocates identity; KIMI_HOME is not read by this CLI
 *   (verified: a run under an overridden KIMI_HOME used the default config).
 * - `kimi provider list --json` dumps the provider/model config as JSON; the
 *   keys of `models` are exactly the aliases `--model` accepts. It is the
 *   config.toml of the inherited environment that is read, so a named
 *   instance with a different config.toml is listed as the default one is.
 */
export const kimiAdapter: AdapterSpec = {
  app: "kimi",
  adapterVersion: 1,
  binary: "kimi",
  identityEnv: "KIMI_CODE_HOME",
  models: [{ model: "kimi-k3", slug: "kimi-code/k3" }],
  listModels: {
    argv: ["provider", "list", "--json"],
    extract: { kind: "json", path: "models" },
  },
  invoke: {
    argv: [
      "--model",
      "{slug}",
      "--output-format",
      "stream-json",
      "{autonomyFlags}",
      "-p",
      "{prompt}",
    ],
    promptVia: "argv",
    extract: {
      kind: "jsonl",
      where: { path: "role", equals: "assistant" },
      path: "content",
      take: "last",
    },
  },
  // Final stdout line: {"role":"meta","type":"session.resume_hint","session_id":"session_<uuid>"}.
  sessionRef: {
    kind: "jsonl",
    where: { path: "type", equals: "session.resume_hint" },
    path: "session_id",
    take: "last",
  },
  // `-S, --session [id]` on the same command as `-p` (verified against
  // `kimi --help`; not exercised live — the resume canary is codex-only). The
  // id follows `-S` directly because its value is optional and an absent one
  // opens the interactive picker. Only `--agent`/`--agent-file` are documented
  // as incompatible with `--session`; neither is used here.
  resume: {
    argv: [
      "--model",
      "{slug}",
      "--output-format",
      "stream-json",
      "-S",
      "{sessionRef}",
      "{autonomyFlags}",
      "-p",
      "{prompt}",
    ],
  },
  autonomyFlags: { full: [] },
  defaultAutonomy: "full",
  defaultTimeoutMs: 300_000,
  // This CLI cannot distinguish "unknown model" from "no models configured for
  // this identity" — both produce the same string with the slug substituted in.
  // Treating it as an admission failure is the safe read: an instance whose
  // config dir has no credentials produces exactly this.
  admissionFailurePatterns: ["is not configured in config.toml"],
  // The assistant role marker is the one work-started signal this stream is
  // known to emit (it is the same line the extractor reads the answer from);
  // nothing was captured about kimi's tool events during the probe, so nothing
  // is claimed here. The admission pattern above is a startup config error
  // that cannot appear once a turn is under way, so the pair is still tight.
  workStartedPatterns: ['"role":"assistant"'],
};
