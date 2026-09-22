Baton runs a self-contained task in another agent CLI on this machine, using that app's account and tools. The callee shares the filesystem but starts with a fresh conversation.

### Delegate a task

1. Use `list_models` to find available models, supported permissions and account availability. Choose a model suited to the task. Delegation is useful for independent implementation, a second opinion or work that needs another model. Keep small tasks local when a briefing would take more work than the task.
2. Call `run_model` with the model, prompt and working directory. Include the objective, paths, constraints and expected result. The callee cannot see your conversation. For concurrent work, use separate checkouts for writers and `options.autonomy: "readonly"` for reviews.
3. Use `wait: false` for long work. Continue other work, then call `get_run(run_id, wait: true)`. A `running` status means the run is still active. The wait budget and the run's optional timeout are separate. Use `cancel_run(run_id)` to stop it.
4. Inspect the returned result and verify any changes before using them. Continue the same session with `resume_run` when a follow-up needs its context. Omitted options are inherited; explicit options apply to the new turn within the current permission ceiling.

An optional `idempotency_key` makes identical retries return the same run. Use a new key if the request changes. Baton enforces the configured delegation depth and supported permission levels; `list_models` reports availability reasons.

When working as a callee, stay within the delegated task, return a standalone answer and stop. Delegate onward only when it helps with that task.
