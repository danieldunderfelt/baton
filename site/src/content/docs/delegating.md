---
title: "Delegating work"
description: "Hand work to a model in another agent app, from MCP tools or the shell."
order: 2
---

Baton lets the agent you are talking to hand work to a model running in a different agent app on the same machine, on that app's own subscription. Any app that can use MCP tools can be a caller; being a callee is what needs an adapter, because Baton runs callees through their command-line interface.

## From an agent, through MCP

- `list_models` reports model routes, supported permission levels, availability reasons and optional ratings. Pooled accounts include estimated quota headroom based on runs Baton observed.
- `run_model(model, prompt, ...)` runs the prompt on another app and returns the answer. The prompt must be self-contained: the callee shares the filesystem but has none of the caller's conversation.
- `get_run(run_id)` polls a long run started with `wait: false`.
- `resume_run(run_id, prompt)` continues a finished run inside the callee's own session, on the same account it originally ran on.
- `cancel_run(run_id)` requests cancellation, including runs owned by another Baton process in the same scope. If the response still says `running` with `cancellationRequested`, use `get_run` to wait for the terminal result.

For long tasks, pass `wait: false`, keep the returned run ID and continue other work. A wait returning `running` means the task is still active; it does not mean a timeout occurred. Use separate checkouts for concurrent writers and readonly permissions for reviews.

## From the shell

```sh
baton run kimi-k3 "Summarise the failure modes in src/quota/quota.ts"
baton run gpt-5.6-luna --timeout 60000 "Reply with exactly: PONG"
baton runs                 # recent runs
baton resume run_abc123 "Now apply the fix you proposed"
baton runs run_abc123 --json
baton cancel run_abc123
```

The CLI prints the answer to stdout and the run ID, resolved permissions, timeout and status to stderr. `run`, `resume`, `runs`, `cancel`, `models` and `status` accept `--json`. Run and resume output includes the resolved `options`, and failed runs return a nonzero exit status.

The CLI waits for runs it starts. Use MCP with `wait: false` when a run needs to continue after the caller receives its handle. `baton cancel` waits for the run's processes to stop; Ctrl-C also stops the run supervised by that CLI.

## Continuing a session

```sh
baton resume run_abc123 "Now apply the fix" --autonomy edits --timeout 120000
```

A resumed turn keeps the original session, account, working directory and category. Omitted options inherit the prior turn's values. Explicit autonomy and timeout settings apply to the new turn, with autonomy constrained by the current scope ceiling. This allows a readonly review to continue as implementation without starting a new conversation.

The run record reports the actual options. Baton prevents concurrent turns in the same session, including attempts to resume different ancestors. After failover, continuation uses the account and adapter that produced the answer.

## How model names work

Which models an app serves is the app's business, not Baton's. Each adapter knows how to ask its CLI (`codex debug models`, `kimi provider list --json`, `opencode models`, `cursor-agent models`), and every model reported is a route under the app's own slug. `baton run gpt-6-astra ...` works the day codex starts listing it, and `baton run github-copilot/claude-opus-5 ...` reaches whatever OpenCode's providers are logged into. Claude Code has no listing command, so any full `claude-*` id is passed through as given.

The short canonical names (`kimi-k3`, `muse-spark-1.3`, `gpt-5.6-sol`) are pinned aliases that ratings attach to. `baton detect` shows installed CLIs and versions; `baton models` lists routes. Catalog probes use each account's effective environment and keep results separate, with a five-minute cache. Slow probes do not block active runs. When listing fails, Baton retains pinned routes and reports the listing error.

## Safety rails

These apply to every run:

- Delegation depth is capped (two hops by default), so agents cannot recurse into each other forever.
- A per-app autonomy ceiling (`baton set max_autonomy:codex readonly`) limits what delegated agents may do. Callers can request less autonomy than the ceiling, never more.
- Retries are safe: `run_model` takes an `idempotency_key`, and the same key with the same request returns the existing run instead of paying for a second one.
- Built-in adapters have no default run deadline. Callers can set `--timeout` or `options.timeoutMs`, and registered adapters can specify a default. Cancellation and timeouts stop the process group before Baton records a terminal result.

Delegated prompts go to the selected CLI and may be sent to its model provider. [Baton profile sharing](/docs/sharing) is separate and does not upload run prompts or transcripts.
