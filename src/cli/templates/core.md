Baton hands a self-contained task to a model running in another agent CLI on this machine, on that app's own subscription, with its own tools and a fresh context, and returns its final answer. The tools come from the MCP server `baton`: `list_models`, `run_model`, `get_run`, `report_result`, `run_duel`, `report_duel`.

### When to reach for it

- "baton" is a trigger word. If the user says it, or names a model ("ask kimi-k3", "have sol review this", "second opinion from opus"), the work goes through these tools. Not into your own context, and not through an ad-hoc shell call to the CLI.
- Bulk and mechanical work goes to a fast cheap model: clear-spec implementation, migrations, mass edits, data munging.
- Reviews, plans and hard debugging go to a strong model, preferably not the one that wrote the code.
- Skip delegation when the briefing would be longer than the work. Baton buys capacity, not thinking.

### How

1. Call `list_models` when you are unsure what this machine can reach. It reports what is available in this environment, each model's live rating (observed evidence and seeded prior, kept apart), and how much quota is left. Trust it over any static opinion about which model is best, including the roster below and your own.
2. Call `run_model(model, prompt, cwd?, wait?, category?, options?, idempotency_key?)`:
   - `prompt` must be self-contained. The callee shares your filesystem and none of your context: no chat history, no earlier tool output, no user messages. State the task, the paths to read, the constraints, and the exact shape of the answer you want back.
   - `cwd` defaults to your working directory. Set it to aim the callee at another checkout.
   - `idempotency_key` is one stable string per logical task, bound to the payload. Reuse it only for a byte-identical retry of the same request. A changed prompt, `cwd` or `options` under the old key comes back as an error, so mint a new key whenever the request changed.
   - `wait: false` for anything long-running, then poll `get_run(run_id)` and do something else meanwhile.
   - Delegation depth is capped at two hops by default (`BATON_HOPS`): a callee may delegate onward once, and its callee is refused. Plan chains instead of discovering the refusal at runtime.
3. The callee is a real agent with tools and it will edit files. Run one writer per checkout at a time, and give parallel delegations `options.autonomy: "readonly"` so reviews and analysis cannot collide. An adapter that cannot express the level you asked for refuses the run rather than quietly running at another one. `kimi` is non-interactive at `full` only, so readonly work goes to `codex`, `claude-code` or `cursor-agent`.

### Models to start from

- `gpt-5.6-sol`, codex's strong model. Reviews, design critique, tricky implementation. Slow.
- `gpt-5.6-luna`, fast and cheap. Mechanical edits, boilerplate, summarising, anything with a spec tight enough to follow literally.
- `kimi-k3`, a strong generalist with good taste. Second-opinion reviews, and implementation where code quality matters.
- `opus-5` and `sonnet-5`, via Claude Code. Opus for hard reasoning, sonnet when speed matters more than depth.
- `grok-4.6`, via cursor-agent. Quick, and a different family when two opinions have deadlocked.
- `ox-alpha`, via opencode. A capable all-rounder from outside the other families.

These are the user's starting priors. `list_models` reports what the evidence says instead, so believe it when the two disagree. It also lists every model each app reports it can serve, under the app's own slug (`gpt-6-astra`, `github-copilot/claude-opus-5`, `cursor-grok-4.6-xhigh`), and Claude Code takes any full `claude-*` id. A newly released model needs no Baton change: name it as its app does.

### Afterwards

- Read what came back before you use it. Delegated answers can be confidently wrong or thinner than they look. Verify against the files, and say so plainly when a result was not good enough rather than passing it on as fact.
- Grade it once you have used it: `report_result(run_id, grade, notes?)` on the 1-5 scale, scored on how useful the answer turned out to be. Not on how it read when it arrived, and not on the model's reputation. Those grades are the evidence `list_models` routes on; a run nobody grades teaches Baton nothing.
- When two models are genuinely in contention, `run_duel([a, b], prompt)` runs both on the identical prompt and hands back answers labelled A and B with the models hidden. Judge on the answers alone, then `report_duel(duel_id, "A" | "B" | "tie")`, which reveals which was which. Both sides run in the same directory, so duels are for non-mutating work. Two agents editing one checkout is a race, not a comparison.
