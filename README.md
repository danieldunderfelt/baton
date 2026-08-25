# Baton

Baton lets the coding agent you are talking to hand work to a model running in a *different* agent app on the same machine, on that app's own subscription. Claude Code can ask a codex model to review a diff. Codex can push a migration onto kimi. Any supported app can be the caller or the callee.

It exists because the alternative is a pile of per-agent instructions telling each one how to shell out to the others, which breaks silently every time a CLI changes a flag. Baton knows how to drive each CLI, records every run, and learns from graded results which model to pick next time.

Supported apps: Claude Code, Codex, Kimi Code, OpenCode, Cursor Agent. Unknown apps can be added at runtime without editing any config file (see "Adding a new app" below).

## How it works

Baton is one binary with two faces:

- `baton mcp` runs an MCP server over stdio. Agent apps call its tools (`run_model`, `get_run`, `list_models`, ...) to delegate work.
- `baton <subcommand>` is the CLI for humans: one-off runs, configuration, ratings, and the approval steps that must never be automated.

When a run comes in, Baton picks a route for the requested model, spawns that app's CLI with the environment it inherited, captures the answer, and stores the whole run in SQLite. Nothing runs through an API proxy; the CLIs themselves execute the work, which is what makes the existing subscriptions usable.

## Install

Requires [Bun](https://bun.sh).

```sh
bun install
bun run build          # compiles dist/baton, a single self-contained binary
```

Then register Baton with the apps you use:

```sh
baton install claude-code   # writes .mcp.json + a skill that teaches Claude when to delegate
baton install codex         # registers the MCP server and adds an AGENTS.md block
baton install kimi
baton install opencode
```

Each installer writes the host's native config plus an instruction block in the host's own dialect, so the agent knows when and how to delegate without being told. Add `--with-eval` to also install the grading instructions (recommended; ratings do not improve without grades).

`baton detect` shows which app CLIs are installed and which models they serve. `baton status` shows where Baton's state lives and which identity variables are set.

## Delegating

From an agent, through MCP:

- `list_models` reports every model this machine can reach, with live ratings and remaining quota.
- `run_model(model, prompt, ...)` runs the prompt on another app and returns the answer. The prompt must be self-contained: the callee shares the filesystem but has none of the caller's conversation.
- `get_run(run_id)` polls a long run started with `wait: false`.
- `resume_run(run_id, prompt)` continues a finished run inside the callee's own session, on the same account it originally ran on.

From the shell:

```sh
baton run kimi-k3 "Summarise the failure modes in src/quota/quota.ts"
baton run gpt-5.6-luna --timeout 60000 "Reply with exactly: PONG"
baton runs                 # recent runs
baton resume run_abc123 "Now apply the fix you proposed"
```

Safety rails that apply to every run:

- Delegation depth is capped (two hops by default), so agents cannot recurse into each other forever.
- A per-app autonomy ceiling (`baton set max_autonomy:codex readonly`) limits what delegated agents may do. Callers can request less autonomy than the ceiling, never more.
- Retries are safe: `run_model` takes an `idempotency_key`, and the same key with the same request returns the existing run instead of paying for a second one.
- Timeouts kill the callee's whole process tree, and Baton verifies the processes are actually dead before recording the result.

## Ratings

Baton routes on evidence and keeps the kinds of evidence separate:

- Grades. After using a delegated answer, the agent (or you) grades it 1-5: `baton grade <run-id> 4 "needed one fix"`. Grades decay with a 90-day half-life, so old evidence fades.
- Seeded opinions. `baton profile import <file>` loads your starting opinion of each model before any evidence exists. Seeds are capped at the weight of a few observations, so a wrong guess cannot steer routing for months.
- Duels. `baton duel <model-a> <model-b> "<prompt>"` runs both models on the identical prompt and shows the answers labelled A and B with the models hidden. Judge, then `baton duel report <id> A`. Verdicts feed a Bradley-Terry strength score, reported separately from grades.

`baton ratings` prints the current table. `ratings.yaml` in the config directory is the same thing as a file, regenerated on every change; it is display-only and Baton never reads it back. `baton profile export` emits a shareable file containing only model opinions, never your prompts, accounts, or machine details.

## Multiple accounts

If you have two Claude subscriptions, Baton can spread work across them:

```sh
baton instance add claude-code personal-2 --env CLAUDE_CONFIG_DIR=~/.claude2
baton pool set claude-code default personal-2
```

Selection favours the account with the most quota headroom, so both usage windows stay warm instead of one draining first. An account that hits a rate limit before starting work goes into cooldown and the run retries on the next account. If a failure happens after work may have started, Baton fails the run instead of silently re-running it, because the first attempt may have edited files.

Per-account spending policy: `baton set preciousness:claude-code:personal-2 conserve` (levels: `burn`, `conserve`, `emergency`).

## Separate worlds

`BATON_CONFIG_DIR` relocates everything Baton knows: config, accounts, pools, quota history, ratings, the database. Set it per directory with direnv and a work checkout gets a Baton that only knows work accounts, while your personal projects get another that only knows personal ones. The two cannot leak into each other because neither knows the other exists.

Baton never inspects or enforces identity. It runs each CLI with the environment it inherited, exactly as if you had typed the command in that shell. Whatever account the environment supplies is the account that runs.

## Adding a new app

Any agent can onboard an app Baton has never heard of:

1. The agent calls `discover_app("someapp")` and gets a checklist: probe the CLI, find its non-interactive mode, its output format, its model names.
2. It submits what it found with `register_app(spec)`. The spec is data, not code: an executable path, argument lists, and rules for extracting the answer. Baton stores it quarantined and executes nothing.
3. You review and approve in the terminal: `baton adapters review someapp`, then `baton adapters approve someapp --digest <shown-in-review>`. Approval requires a terminal and the digest of the exact spec you reviewed.
4. Baton runs one canary prompt through the app to verify the answer comes back intact, then activates it. From then on it routes like any built-in.

If the app's binary is later upgraded, the adapter is marked stale and re-verified before it runs again.

## What Baton does not do

- It does not verify identity. Environment separation is your direnv setup's job; Baton just inherits what it is given.
- It does not sandbox callees beyond the autonomy flags each CLI itself offers. You choose what your agents may do.
- It cannot stop a full-permission local agent from doing what you yourself could do in a terminal, including approving adapters. The approval step protects against accidents, not against an agent you have already given your shell.
- Raw prompts stay on your machine, in a capped ring buffer (about 2,000 runs). Only aggregate ratings are shareable.

## Development

```sh
bun test               # full suite; no live CLI calls, no quota spent
BATON_LIVE_TESTS=1 bun test src/adapters/builtin   # live canaries, costs a few real prompts
bunx tsc --noEmit
bun run build
```

PLAN.md is the design document, including the review log of every design decision and external code review. Server: `baton mcp` (stdio) or `baton serve --http --port 7317` (one daemon per environment).
