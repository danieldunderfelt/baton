# Baton

Baton lets the coding agent you are talking to hand work to a model running in a *different* agent app on the same machine, on that app's own subscription. Claude Code can ask a Codex model to review a diff. Codex can push a migration to Kimi Code. It can also load-balance requests across multiple accounts of the same app (see "Load balancing" below).

Baton handles CLI arguments, model discovery, account selection and run history. Optional grades record how useful an answer was and help with future selection. You can delegate immediately without configuring ratings.

The two roles work differently:

- Calling *into* Baton takes nothing special: any app that can use MCP tools can be a caller. Point it at `baton mcp` and it can delegate.
- Being a *callee* is what needs support, because Baton runs callees through their command-line interface, not through MCP. Built-in callees: Claude Code, Codex, Kimi Code, OpenCode, Cursor Agent. Unknown apps can be added at runtime without editing any config file (see "Adding a new app" below).

For all five built-in apps, `baton install` writes the same on-demand `SKILL.md`. Its description lets the host load Baton when a task fits, and its content stays consistent across callers.

## How it works

Baton is one binary with two faces:

- `baton mcp` runs an MCP server over stdio. Agent apps call its tools (`run_model`, `get_run`, `list_models`, ...) to delegate work.
- `baton <subcommand>` provides shell commands for runs, inspection, configuration and optional ratings.

When a run comes in, Baton picks a route for the requested model, spawns that app's CLI with the environment it inherited, captures the answer, and stores the whole run in SQLite. Nothing runs through an API proxy; the CLIs themselves execute the work, which is what makes the existing subscriptions usable.

## Install

Install Baton once per machine:

```sh
curl -fsSL https://raw.githubusercontent.com/danieldunderfelt/baton/main/install.sh | sh
baton install --user
```

The first command puts a self-contained `baton` in `~/.local/bin` (macOS or Linux, arm64 or x64, checksum verified; no Bun needed). The second command registers Baton with the five caller hosts it finds on `PATH`: Claude Code, Codex, Kimi Code, OpenCode, and Cursor Agent. It writes each host's global config and the same skill, which teaches the agent when to delegate and how to grade what comes back.

Shells use the first matching executable in `PATH`. Check which binary your shell will run with `type -a baton`, and put the user install first when needed:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Start a new agent session after installing or updating so it loads the new MCP server. A session that is already running keeps its old server.

`baton --help` lists commands. `baton <command> --help` and `baton help <command>` show focused help without running the command. For old binaries, see [recovering a v0.1.0 installation](site/src/content/docs/installation.md#recovering-a-v010-install).

To update:

```sh
baton update
```

That replaces the binary with the latest release, or rebuilds a checkout, and refreshes existing Baton-owned skills recorded by `baton install`. It preserves host configuration and unrelated instructions. Older installations in the current project and configured home locations are recognized too. Other projects installed before tracking was added need one `baton install` to enter the manifest. Sessions already running keep the old server until they restart.

To keep an install inside one checkout instead of the whole machine, run `baton install`, optionally naming hosts or passing `--dir <path>`, in that directory. It writes the selected hosts' MCP files and skills. `--no-eval` leaves out the optional ratings appendix. Neither installation nor delegation requires a rating interview.

Codex, Kimi, OpenCode, and Cursor share one skill at `.agents/skills/baton/SKILL.md`. Project installs place it at the nearest Git root, or the target directory when there is no Git root. User installs place it at `~/.agents/skills/baton/SKILL.md`. Claude gets the same content in `.claude/skills/baton/SKILL.md` (project) or `~/.claude/skills/baton/SKILL.md` (user).

| Host | Project MCP config | User MCP config |
|---|---|---|
| Claude Code | `.mcp.json` | `~/.claude.json` |
| Codex | `.codex/config.toml` | `~/.codex/config.toml` |
| Kimi Code | `.mcp.json` when the target is a Git root; otherwise `.kimi-code/mcp.json` | `~/.kimi-code/mcp.json` |
| OpenCode | `opencode.json` or existing `opencode.jsonc` | `~/.config/opencode/opencode.json` or existing `opencode.jsonc` |
| Cursor Agent | `.cursor/mcp.json` | `~/.cursor/mcp.json` |

`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `KIMI_CODE_HOME`, and `XDG_CONFIG_HOME` relocate their corresponding user MCP configs; `OPENCODE_CONFIG` selects OpenCode's MCP config file. Claude's skill also follows `CLAUDE_CONFIG_DIR`. The shared skill stays in `~/.agents/skills` regardless of these overrides. Cursor may prompt you to approve Baton; you can also run `cursor-agent mcp enable baton`.

Reinstalling updates the skill and MCP registration. When installing a host that uses the shared skill, Baton also removes its complete standalone `<!-- baton:begin -->` … `<!-- baton:end -->` blocks from the old `AGENTS.md`, preserving the surrounding file. A Claude-only install leaves that file alone. Fresh installs do not create `AGENTS.md`; incomplete or nested markers stop migration for that host before its files are written.

Baton-only regular files are removed after migration; symlinks stay intact.

`baton detect` shows which app CLIs are installed and which models they serve. `baton status` shows where Baton's state lives and which identity variables are set.

Contributors: clone the repo, install [Bun](https://bun.sh), and `./install.sh` builds from source into `~/.local/bin`. See [Releasing](#releasing) to publish a version. There is no Windows build because Baton's process-tree cleanup relies on POSIX process groups.

## Delegating

From an agent, through MCP:

- `list_models` reports every model this machine can reach, with live ratings and estimated quota headroom for pooled accounts.
- `run_model(model, prompt, ...)` runs the prompt on another app and returns the answer. The prompt must be self-contained: the callee shares the filesystem but has none of the caller's conversation.
- `get_run(run_id)` polls a long run started with `wait: false`.
- `resume_run(run_id, prompt)` continues a finished run inside the callee's own session, on the same account it originally ran on.
- `cancel_run(run_id)` requests cancellation, including work owned by another Baton process in the same scope. Poll `get_run` if cancellation is still pending.

From the shell:

```sh
baton run kimi-k3 "Summarise the failure modes in src/quota/quota.ts"
baton run gpt-5.6-luna --timeout 60000 "Reply with exactly: PONG"
baton runs                 # recent runs
baton resume run_abc123 "Now apply the fix you proposed"
baton cancel run_abc123     # waits for the run's processes to stop
baton runs run_abc123 --json
```

Shell runs print the answer to stdout and the run ID, resolved permissions and status to stderr. `run`, `resume`, `runs`, `cancel`, `models` and `status` accept `--json`. Run and resume records include the actual resolved `options`.

A resumed turn inherits omitted options. Explicit `--autonomy` and `--timeout` values apply to the new turn, subject to the current permission ceiling. A readonly review can therefore continue with an implementation turn. Baton prevents simultaneous turns from writing to the same session, including resumes from different ancestors.

Each adapter asks its CLI for model names when it has a listing command. Reported models are available under the app's own slug; pinned names such as `kimi-k3` are aliases. Claude Code has no listing command, so full `claude-*` IDs pass through as given. `baton models` shows routes, availability and supported permission levels. Catalog probes use each account's effective environment and cache results separately for five minutes. A failed listing keeps pinned routes available and reports its error. Block routes you never want used, for example `baton block add 'opencode/github-copilot/*'`.

OpenCode profiles use separate XDG data roots. `XDG_DATA_HOME` moves the
credential store as well as sessions and logs. Profile configs belong in
`~/.config/opencode`, selected with `OPENCODE_CONFIG`, not in a checkout — for
example an `opencode-finnair.json` that enables only `github-copilot`.

Execution rules:

- Delegation depth is capped (two hops by default), so agents cannot recurse into each other forever.
- A per-app autonomy ceiling (`baton set max_autonomy:codex readonly`) limits what delegated agents may do. Callers can request less autonomy than the ceiling, never more.
- Retries are safe: `run_model` takes an `idempotency_key`, and the same key with the same request returns the existing run instead of paying for a second one.
- Built-in adapters have no default run deadline. Set `--timeout` or `options.timeoutMs` when a turn needs one; registered adapters can also specify a default. Timeouts and cancellation stop the callee's process group before Baton records the terminal result. An MCP wait returning `running` does not mean the run timed out.

## Ratings

Baton routes on evidence and keeps the kinds of evidence separate:

- Grades. After using a delegated answer, the agent (or you) grades it 1-5: `baton grade <run-id> 4 "needed one fix"`. Grades decay with a 90-day half-life, so old evidence fades.
- Seeded opinions. `baton profile import <file>` loads your starting opinion of each model before any evidence exists. Seeds are capped at the weight of a few observations, so a wrong guess cannot steer routing for months.
- Duels. `baton duel <model-a> <model-b> "<prompt>"` runs both models on the identical prompt and shows the answers labelled A and B with the models hidden. Judge, then `baton duel report <id> A`. Verdicts feed a Bradley-Terry strength score, reported separately from grades.

`baton ratings` prints the current table. `baton ratings export` writes a `ratings.yaml` snapshot on demand; grades and settings do not maintain that file. SQLite remains the source for routing. `baton profile export` emits a shareable file containing model priors, without local run history or account configuration.

To hand a profile to someone without passing files around, share it through the Baton site:

```sh
baton profile share                    # signs in with GitHub the first time
# Shared profile 'mine' (12 priors) as @you.
#   Link:   https://baton.sh/p/k7mq3-v2xrd
#   Import: baton profile import k7mq3-v2xrd
```

`baton profile import <file-or-code-or-link>` applies immediately and prints the changes. Use `--dry-run` to preview. The first imported profile activates automatically; later imports switch profiles only with `--activate`. Replacing a profile saves its previous version under `profile-backups` and prints a restore command. Shared profiles default to the name `<login>/<name>`.

Sharing the same profile again updates its link. `baton profile shares` and `baton profile unshare <code>` manage shares; `baton login` and `baton logout` manage the scope's sharing token. The service allows 100 profiles and 5 MiB of stored profile JSON per account. Listings are paginated and the CLI fetches every page. Anyone holding a share code can read that profile.

## Load balancing

If you have two subscriptions for the same app, Baton can treat them as one bigger one. This works for any app whose account follows an environment variable: Claude Code (`CLAUDE_CONFIG_DIR`), Codex (`CODEX_HOME`), and Kimi Code (`KIMI_CODE_HOME`). Log the second account in once, tell Baton about it, and pool them:

```sh
CLAUDE_CONFIG_DIR=~/.claude2 claude    # log in once, interactively
baton instance add claude-code personal-2 --env CLAUDE_CONFIG_DIR=~/.claude2
baton pool set claude-code default personal-2
```

From then on every delegation to an opus or sonnet model picks an account automatically:

- Selection favours the less-used account based on runs Baton observed in the last five hours and seven days. This estimates relative headroom; it does not read subscription limits or usage outside Baton.
- An admission failure puts the account into an exponential cooldown backoff, and the run retries on the next account under the same run id.
- Failover only happens when the refusal provably came before any work started. If a failure happens after work may have begun, Baton fails the run instead of silently re-running it, because the first attempt may have edited files.
- Resumed runs skip the pool and go back to the account that holds the session.
- `baton pool list` shows the live picture: headroom per account and who is cooling down.

Per-account spending policy: `baton set preciousness:claude-code:personal-2 conserve`, with levels `burn`, `conserve` and `emergency`. An `emergency` account can still be selected as a fallback. Use an explicit block when an account must never be used in a scope.

## Blocking a route

Some routes are reachable and still off limits — a client's enterprise seat that happens to be logged into an app on this machine, a provider you would rather not send work to. Baton does not verify identity, so it cannot know that on its own; you tell it:

```sh
baton block add 'opencode/github-copilot/*' client enterprise subscription
baton block add 'opencode/github-copilot/<slug>'                   # just one model
baton block add cursor-agent                                       # a whole app
```

A pattern addresses a route the way Baton names one internally — `<app>[:<instance>]/<slug>`, with `*` matching anything. Leave the instance off and it covers every account; name one (`codex:work/*`) and it covers only that account. `baton block add` prints the routes it matches right now, so a typo shows up immediately.

To disable a whole app, use the same commands for built-in and registered adapters:

```sh
baton adapters disable opencode
baton adapters enable opencode
```

A blocked route is excluded from normal runs, failover, resumes and optional adapter diagnostics. `list_models` reports the reason. Use `baton block list` and `baton block remove <pattern>` to manage route patterns. Agents can enable or disable a whole app with `set_app_enabled(app, enabled)`.

## Separate worlds

`BATON_CONFIG_DIR` separates Baton's configuration, named accounts, pools, history, ratings and sharing login. Set it per directory with direnv when those records should be independent. This does not isolate the underlying CLI's credentials: the default account still comes from the inherited environment, and two scopes can reach the same account.

Baton never inspects or enforces identity. It runs each CLI with the environment it inherited, exactly as if you had typed the command in that shell. Whatever account the environment supplies is the account that runs.

## Adding a new app

Any agent can onboard an app Baton has never heard of:

1. The agent calls `discover_app("someapp")` and gets a checklist: probe the CLI, find its non-interactive mode, its output format, its model names.
2. It submits what it found with `register_app(spec)`. The spec is: an executable path, argument lists, and rules for extracting the answer.
3. A valid registration is enabled immediately. Registering identical content is a no-op; an invalid replacement leaves the working spec alone. Explicit disables survive spec updates.
4. Optionally call `test_app(app)` or run `baton adapters test <app>` to check execution and answer extraction. Tests use the selected account and obey blocks and permission ceilings. Registration itself makes no model call.

From the shell, `baton adapters add <spec.json>` registers an adapter and `baton adapters show <app>` prints its spec. `baton adapters test --all --structural` validates declarations without model calls. Upgrading the CLI does not disable its adapter; diagnostics remain optional. There is no adapter approval command, digest-copying step or mandatory diagnostic.

## What Baton does not do

- It does not verify identity. Environment separation is your direnv setup's job; Baton just inherits what it is given. `baton block` is the escape hatch for routes you know must not be spent — a rule you state, not one Baton infers.
- It does not sandbox callees beyond the autonomy flags each CLI itself offers. You choose what your agents may do.
- It cannot restrict a full-permission local agent beyond the controls enforced by that agent's host.
- Baton stores local run history, with a default retention cap of about 2,000 completed runs. Delegated prompts go to the selected CLI and may be sent to its model provider. The optional Baton sharing service receives profile priors and sharing-account information, not run prompts or transcripts. Profile names and categories are free text and are included when shared.

## Development

```sh
bun run test           # CLI suite; no live CLI calls, no quota spent
BATON_LIVE_TESTS=1 bun test src/adapters/builtin   # live canaries, costs a few real prompts
bunx tsc --noEmit
bun run build
```

Server: `baton mcp` (stdio) or `baton serve --http --port 7317` (one daemon per environment).

The website and the profile-sharing service live in `site/` (Astro on Cloudflare Workers with D1); see `site/README.md` for running it locally and deploying. `BATON_SITE_URL` points the CLI at a local or self-hosted instance.

## Releasing

Commit and push your changes to `main`, then choose an unused version:

```sh
bun run release 0.2.2 --dry-run
bun run release 0.2.2
```

The command updates `package.json`, validates the CLI and website, commits the version change, creates an annotated tag, and pushes the commit and tag together. GitHub Actions then builds, verifies, and publishes the release binaries. Existing tags are never moved or overwritten.

See the [release guide](site/src/content/docs/releasing.md) for prerequisites, publication status, and recovery after a failed step.
