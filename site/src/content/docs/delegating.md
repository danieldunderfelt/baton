---
title: "Delegating work"
description: "Hand work to a model in another agent app, from MCP tools or the shell."
order: 2
---

Baton lets the agent you are talking to hand work to a model running in a different agent app on the same machine, on that app's own subscription. Any app that can use MCP tools can be a caller; being a callee is what needs an adapter, because Baton runs callees through their command-line interface.

## From an agent, through MCP

- `list_models` reports every model this machine can reach, with live ratings and remaining quota.
- `run_model(model, prompt, ...)` runs the prompt on another app and returns the answer. The prompt must be self-contained: the callee shares the filesystem but has none of the caller's conversation.
- `get_run(run_id)` polls a long run started with `wait: false`.
- `resume_run(run_id, prompt)` continues a finished run inside the callee's own session, on the same account it originally ran on.

## From the shell

```sh
baton run kimi-k3 "Summarise the failure modes in src/quota/quota.ts"
baton run gpt-5.6-luna --timeout 60000 "Reply with exactly: PONG"
baton runs                 # recent runs
baton resume run_abc123 "Now apply the fix you proposed"
```

Why run models from the shell through Baton instead of the CLI directly? Partly because it was free to implement, but mostly because every run gets the same routing: load balancing across accounts, quota awareness, and a recorded, gradeable result.

## How model names work

Which models an app serves is the app's business, not Baton's. Each adapter knows how to ask its CLI (`codex debug models`, `kimi provider list --json`, `opencode models`, `cursor-agent models`), and every model reported is a route under the app's own slug. `baton run gpt-6-astra ...` works the day codex starts listing it, and `baton run github-copilot/claude-opus-5 ...` reaches whatever OpenCode's providers are logged into. Claude Code has no listing command, so any full `claude-*` id is passed through as given.

The short canonical names (`kimi-k3`, `ox-alpha`, `gpt-5.6-sol`) are pinned aliases that ratings attach to. `baton detect` shows what each app reports right now, `baton models` the whole roster. Listings are cached for five minutes in `~/.cache/baton/catalog.json`, and a CLI that will not list keeps its pinned routes.

## Safety rails

These apply to every run:

- Delegation depth is capped (two hops by default), so agents cannot recurse into each other forever.
- A per-app autonomy ceiling (`baton set max_autonomy:codex readonly`) limits what delegated agents may do. Callers can request less autonomy than the ceiling, never more.
- Retries are safe: `run_model` takes an `idempotency_key`, and the same key with the same request returns the existing run instead of paying for a second one.
- Timeouts kill the callee's whole process tree, and Baton verifies the processes are actually dead before recording the result.
