---
name: baton
description: Delegate a self-contained task to another model through the Baton MCP server. Use for an explicitly requested model handoff, independent implementation, a second opinion, or a blind model comparison.
---

## Delegating with Baton

Use the Baton MCP tools for delegation. If they are unavailable, report that the registered server needs to be enabled in a new session. Do not substitute direct calls to agent CLIs.

Baton runs a self-contained task in another agent CLI on this machine, using that app's account and tools. The callee shares the filesystem but starts with a fresh conversation.

### Delegate a task

1. Use `list_models` to find available models, supported permissions and account availability. Choose a model suited to the task. Delegation is useful for independent implementation, a second opinion or work that needs another model. Keep small tasks local when a briefing would take more work than the task.
2. Call `run_model` with the model, prompt and working directory. Include the objective, paths, constraints and expected result. The callee cannot see your conversation. For concurrent work, use separate checkouts for writers and `options.autonomy: "readonly"` for reviews.
3. Use `wait: false` for long work. Continue other work, then call `get_run(run_id, wait: true)`. A `running` status means the run is still active. The wait budget and the run's optional timeout are separate. Use `cancel_run(run_id)` to stop it.
4. Inspect the returned result and verify any changes before using them. Continue the same session with `resume_run` when a follow-up needs its context. Omitted options are inherited; explicit options apply to the new turn within the current permission ceiling.

An optional `idempotency_key` makes identical retries return the same run. Use a new key if the request changes. Baton enforces the configured delegation depth and supported permission levels; `list_models` reports availability reasons.

When working as a callee, stay within the delegated task, return a standalone answer and stop. Delegate onward only when it helps with that task.

### Optional ratings and comparisons

Baton works without ratings or a setup interview. After using an answer, `report_result(run_id, grade, notes?)` can record its usefulness on a 1–5 scale. Grade the answer, not the model's reputation or execution speed. A failure without an answer is already tracked as execution reliability. Re-reporting replaces the earlier grade.

Use `run_duel([a, b], prompt)` for a blind comparison of two models, then `report_duel(duel_id, "A" | "B" | "tie")` after judging the answers. Duels share a directory and must be non-mutating.

If the user requests model preferences, `seed_ratings(profile_name, entries)` records them. Use canonical model IDs and distinguish quality from speed or cost. No extra confirmation is needed for an explicitly requested preference change. `baton profile import` imports a shared profile; `--dry-run` previews it. The first profile activates automatically.

`baton ratings` shows the evidence. `baton ratings export` writes a snapshot when needed. Account pools, spending preferences and shared profiles are optional configuration.

<!-- baton:skill eval=true -->
