---
name: baton
description: Delegate a self-contained task to another model running in a local agent CLI (codex, kimi, ...) via the Baton MCP server. Use for bulk or mechanical work that would burn this session's budget, for a second opinion or review from a different model, or whenever the user names a model to hand work to.
---

# Delegating with Baton

Baton runs a prompt through another coding-agent CLI on this machine, on that app's own subscription, and returns its final answer.

## When to delegate

- Bulk and mechanical work — clear-spec implementation, migrations, mass edits, data munging — goes to a fast cheap model.
- Reviews, plans, and hard debugging go to a strong model, preferably not the one that wrote the code.
- Skip delegation when the task needs this conversation more than it needs the extra capacity: if the briefing would be longer than the work, just do it.

## How

1. Call `list_models` first if you are unsure what this machine and environment can reach — availability is per scope, not universal.
2. Call `run_model` with:
   - `model` — canonical id, e.g. `gpt-5.6-sol`.
   - `prompt` — **self-contained**. The callee shares your filesystem but none of your context: no chat history, no earlier tool output, no user messages. State the task, the paths to read, the constraints, and the exact shape of the answer you want back.
   - `cwd` — defaults to your working directory; set it to aim the callee at another checkout.
   - `idempotency_key` — a stable string per logical task, bound to the exact payload. Reuse it only for a byte-identical retry of the same request; a changed prompt, `cwd`, or `options` under the old key comes back as an error, so mint a new key whenever the request changed.
   - `wait: false` for anything long-running, then poll `get_run(run_id)`.
3. The callee is a real agent with tools and will edit files. Run one writer per checkout at a time, and give parallel delegations `options.autonomy: "readonly"` so reviews and analysis cannot collide. An adapter that cannot express the level you asked for refuses the run rather than silently running at some other level — `kimi` runs non-interactively at `full` only, so readonly work goes to `codex`.

## Models

- `gpt-5.6-sol` — the strong codex model: reviews, design critique, tricky implementation. Slower.
- `gpt-5.6-luna` — fast and cheap: mechanical edits, boilerplate, summarising, anything with a spec tight enough to follow literally.
- `kimi-k3` — strong generalist with good taste: second-opinion reviews and implementation where code quality matters.

These are the user's starting priors; `list_models` reports the live rating per model as Baton accumulates evidence, so trust it over this list when the two disagree.

## After

Read what came back before using it. Delegated answers can be confidently wrong or thinner than they look — verify against the files, and say so plainly when the result was not good enough rather than passing it on as fact.
