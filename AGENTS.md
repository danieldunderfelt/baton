<!-- baton:begin -->
## Delegating through Baton

This block is shared by every agent that reads AGENTS.md here (codex, kimi, opencode). It is always in context; the tools are not. If the `baton` tools are not visible in this session, Baton was registered after it started. Tell the user to start a new session, and never shell out to `claude`, `codex`, `kimi`, `cursor-agent` or `opencode` by hand as a substitute.

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

These are the user's starting priors. `list_models` reports what the evidence says instead, so believe it when the two disagree.

### Afterwards

- Read what came back before you use it. Delegated answers can be confidently wrong or thinner than they look. Verify against the files, and say so plainly when a result was not good enough rather than passing it on as fact.
- Grade it once you have used it: `report_result(run_id, grade, notes?)` on the 1-5 scale, scored on how useful the answer turned out to be. Not on how it read when it arrived, and not on the model's reputation. Those grades are the evidence `list_models` routes on; a run nobody grades teaches Baton nothing.
- When two models are genuinely in contention, `run_duel([a, b], prompt)` runs both on the identical prompt and hands back answers labelled A and B with the models hidden. Judge on the answers alone, then `report_duel(duel_id, "A" | "B" | "tie")`, which reveals which was which. Both sides run in the same directory, so duels are for non-mutating work. Two agents editing one checkout is a race, not a comparison.

### Two more things

- Send reviews out of the family, and delegate the volume. Whatever model you are, the review of what you wrote belongs on a strong model from a different family, and the mechanical half of your work belongs on a cheap one. Baton is also how you reach subscriptions this session does not have: `run_model` can put work on the user's Claude, codex or kimi quota regardless of which app you are running in.
- You are often the callee. A prompt that arrives with no conversation behind it is a delegation: answer it standalone, in the shape it asked for, touch only what it asked for, and stop. As a callee under kimi or opencode you run at full autonomy with no readonly mode available.

### Grading what came back

Baton routes on evidence, and the evidence is your grades. Grade a delegation after you have used its result, not when it arrives, and not on how the answer reads.

- `report_result(run_id, grade, notes?)`, where `grade` is 1-5:
  - 5: correct and directly usable
  - 4: usable after small fixes
  - 3: partly usable; half of it had to be redone
  - 2: mostly wrong
  - 1: useless or actively misleading
- Grade the answer's usefulness to you, not the model's reputation, and not how long it took.
- Only a run that produced an answer can be graded; Baton refuses the rest. A crashed CLI, a timeout or an unparseable answer is not a 1. Those count against the execution target as reliability on their own, so there is nothing for you to report.
- `notes` is one line on why. That line is what makes a grade re-readable later.
- Reports are upserts: re-reporting the same `run_id` replaces its grade, so a correction never double-counts.
- From the shell: `baton grade <run_id> <1-5> [notes...]`, and `baton ratings` prints the current table (observed, prior, blended, and which profile the prior came from).
- `report_duel` is an upsert too: a re-judged duel replaces its verdict instead of stacking a second one onto the pair.

### Onboarding: seeding the user's priors

Before there is local evidence, ratings are whatever the user already believes. Once, at setup, or whenever the user wants to revise their opinion of the models, interview them and submit the result with `seed_ratings(profile_name, entries)`:

1. Ask for comparisons, not numbers: "who do you trust for a review?", "is kimi-k3 about as good as opus-5 for implementation?", "which one would you never hand a migration to?". People are calibrated on ordinal and pairwise judgments; invented 1-5 scores are noise.
2. Split multi-axis prose. "Fast but sloppy" is two claims. Speed is routing metadata, not a quality prior, so only the quality claim becomes a seeded rating. Same for cost.
3. Map each claim to an entry: `{ model, category?, mean, weight? }`. Canonical model ids only (`kimi-k3`, never `kimi:default/kimi-code/k3`), `mean` on the 1-5 grade scale, `category` omitted for a general opinion.
4. Echo the normalized entries back and get an explicit yes before calling `seed_ratings`. You propose, the user approves. A seed they did not recognise is a seed that quietly misroutes work.
5. Seed weight is capped at the worth of roughly 5-10 observations on purpose: a wrong seed fades as real grades arrive instead of steering routing for months.

Ask about preciousness in the same conversation: how freely each account may be spent. Set it from the shell, where the trusted config lives: `baton set preciousness:<app>:<instance> burn|conserve|emergency`.
<!-- baton:end -->
