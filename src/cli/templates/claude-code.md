---
name: baton
description: Delegate a self-contained task to another model running in a local agent CLI (codex, kimi, claude-code, opencode, cursor-agent) through the Baton MCP server. Use when the user says "baton", names a model to hand work to ("ask kimi-k3", "have sol review this", "get grok's take"), wants a second opinion, a cross-model review or a blind A/B comparison, or when bulk, mechanical or long-running work would otherwise burn this session's context.
---

## Delegating with Baton

`/baton` invokes this skill explicitly; otherwise use it whenever the description above fits the request. If the `baton` tools are not visible, this session started before Baton was registered — say so rather than shelling out to the agent CLIs by hand.

{core}

### Orchestrating other agents

When you are driving subagents or a multi-stage workflow, the workers should delegate too:

- Give each bulk stage — the mechanical implementation, the migration, the test sweep — to a cheap model through `run_model`, and keep Claude's context for the parts that need the conversation.
- Route cross-model review through Baton as well: a worker that asks `gpt-5.6-sol` or `kimi-k3` to review what another model just wrote leaves a graded run behind, so the evidence accrues instead of evaporating with the subagent's transcript.
- Tell workers to grade what they actually used. A workflow that fires off a hundred delegations and grades none leaves routing exactly where it started.
- Depth is capped at two hops by default (`BATON_HOPS`): a callee may delegate onward once, its callee is refused. Plan the chain instead of discovering the refusal.
