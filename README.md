# Baton

Baton lets the coding agent you are talking to hand work to a model running in a *different* agent app on the same machine, on that app's own subscription. Claude Code can ask a Codex model to review a diff. Codex can push a migration to Kimi Code. It can also load-balance requests across multiple accounts of the same app (see "Load balancing" below).

The alternative is a pile of per-agent instructions telling each one how to shell out to the others, which breaks silently when a CLI changes, or more relevantly, when a new model is released. Baton knows how to drive each CLI, and learns which model is best for each kind of task by recording every run and its graded result.

The two roles work differently:

- Calling *into* Baton takes nothing special: any app that can use MCP tools can be a caller. Point it at `baton mcp` and it can delegate.
- Being a *callee* is what needs support, because Baton runs callees through their command-line interface, not through MCP. Built-in callees: Claude Code, Codex, Kimi Code, OpenCode, Cursor Agent. Unknown apps can be added at runtime without editing any config file (see "Adding a new app" below).

For the built-in apps, `baton install` also writes instructions in each app's own dialect (a skill for Claude Code, an AGENTS.md block for the rest), so their agents know when to delegate without being told.

## How it works

Baton is one binary with two faces:

- `baton mcp` runs an MCP server over stdio. Agent apps call its tools (`run_model`, `get_run`, `list_models`, ...) to delegate work.
- `baton <subcommand>` is the CLI for humans: one-off runs, configuration, ratings, and the approval steps that should never be automated.

When a run comes in, Baton picks a route for the requested model, spawns that app's CLI with the environment it inherited, captures the answer, and stores the whole run in SQLite. Nothing runs through an API proxy; the CLIs themselves execute the work, which is what makes the existing subscriptions usable.

## Install

Building needs [Bun](https://bun.sh); the resulting binary is self-contained and needs nothing.

```sh
git clone <this-repo> && cd baton
./install.sh               # builds and installs to ~/.local/bin/baton
```

Set `BATON_INSTALL_DIR` to install somewhere else. `bun run build:all` cross-compiles standalone binaries for macOS and Linux (arm64 and x64) into `dist/` if you want to copy one to another machine. No Windows build: Baton's process-tree cleanup relies on POSIX process groups.

Then register Baton with the apps you use:

```sh
baton install claude-code   # .mcp.json + a skill that teaches Claude when to delegate
baton install codex         # .codex/config.toml + an AGENTS.md block
baton install kimi          # .mcp.json (which Kimi also reads) + the AGENTS.md block
baton install opencode      # opencode.json + the AGENTS.md block
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

> *Why run models from the shell through Baton instead of the CLI directly?* Partly because it was free to implement, but mostly because every run gets the same routing: load balancing across accounts, quota awareness, and a recorded, gradeable result.

Kimi Code and OpenCode can serve more than one model. Kimi serves whatever its `config.toml` defines. OpenCode serves whatever providers it is logged into, which can reach models no other app has: on a machine with OpenCode's GitHub Copilot provider, `baton run gemini-3.1-pro ...` works even though no Gemini CLI is installed. `baton detect` shows what each app actually serves right now.

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

## Load balancing

If you have two subscriptions for the same app, Baton can treat them as one bigger one. This works for any app whose account follows an environment variable: Claude Code (`CLAUDE_CONFIG_DIR`), Codex (`CODEX_HOME`), and Kimi Code (`KIMI_CODE_HOME`). Log the second account in once, tell Baton about it, and pool them:

```sh
CLAUDE_CONFIG_DIR=~/.claude2 claude    # log in once, interactively
baton instance add claude-code personal-2 --env CLAUDE_CONFIG_DIR=~/.claude2
baton pool set claude-code default personal-2
```

From then on every delegation to an opus or sonnet model picks an account automatically:

- Selection favours the account with the most quota headroom, so both usage windows stay warm instead of one draining while the other sits idle. Subscription quota comes in rolling windows; two accounts drained evenly get you more work per day than two drained in sequence.
- An account that hits a rate limit before starting work goes into cooldown (until the provider's stated reset when one is given, with growing backoff otherwise) and the run retries on the next account under the same run id.
- Failover only happens when the refusal provably came before any work started. If a failure happens after work may have begun, Baton fails the run instead of silently re-running it, because the first attempt may have edited files.
- Resumed runs skip the pool and go back to the account that holds the session.
- `baton pool list` shows the live picture: headroom per account and who is cooling down.

Per-account spending policy: `baton set preciousness:claude-code:personal-2 conserve` (levels: `burn`, `conserve`, `emergency`). An `emergency` account is only picked when every other account is unavailable, which is how "keep the work account out of my hobby projects" becomes one line of config.

## Separate worlds

`BATON_CONFIG_DIR` relocates everything Baton knows: config, accounts, pools, quota history, ratings, the database. Set it per directory with direnv and a work checkout gets a Baton that only knows work accounts, while your personal projects get another that only knows personal ones. The two cannot leak into each other because neither knows the other exists.

Baton never inspects or enforces identity. It runs each CLI with the environment it inherited, exactly as if you had typed the command in that shell. Whatever account the environment supplies is the account that runs.

## Adding a new app

Any agent can onboard an app Baton has never heard of:

1. The agent calls `discover_app("someapp")` and gets a checklist: probe the CLI, find its non-interactive mode, its output format, its model names.
2. It submits what it found with `register_app(spec)`. The spec is: an executable path, argument lists, and rules for extracting the answer.
3. You review and approve in the terminal: `baton adapters review someapp`, then `baton adapters approve someapp --digest <shown-in-review>`. Approval requires a terminal and the digest of the exact spec you reviewed.
4. Baton runs one canary prompt through the app to verify the answer comes back intact, then activates it. From then on it routes like any built-in app/provider.

If the app's binary is later upgraded, the adapter is marked stale and re-verified before it runs again.

## What Baton does not do

- It does not verify identity. Environment separation is your direnv setup's job; Baton just inherits what it is given.
- It does not sandbox callees beyond the autonomy flags each CLI itself offers. You choose what your agents may do.
- It cannot stop a full-permission local agent from doing what you yourself could do in a terminal, including approving adapters. The approval step protects against accidents, not against an agent you have already given full access to your shell.
- Raw prompts stay on your machine, in a capped ring buffer (about 2,000 runs). Only aggregate ratings are shareable.

## Development

```sh
bun test               # full suite; no live CLI calls, no quota spent
BATON_LIVE_TESTS=1 bun test src/adapters/builtin   # live canaries, costs a few real prompts
bunx tsc --noEmit
bun run build
```

PLAN.md is the design document, including the review log of every design decision and external code review. Server: `baton mcp` (stdio) or `baton serve --http --port 7317` (one daemon per environment).
