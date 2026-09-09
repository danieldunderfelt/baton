---
name: baton
description: Delegate a self-contained task to another model running in a local agent CLI (codex, kimi, claude-code, opencode, cursor-agent) through the Baton MCP server. Use when the user says "baton", names a model to hand work to ("ask kimi-k3", "have sol review this", "get grok's take"), wants a second opinion, a cross-model review or a blind A/B comparison, or when bulk, mechanical or long-running work would otherwise burn this session's context.
---

## Delegating with Baton

Use the Baton MCP tools when this skill applies. If the tools are unavailable, tell the user to enable the registered Baton server and start a new session. Do not substitute direct calls to the agent CLIs.

{core}

### Orchestrating other agents

When you are driving subagents or a multi-stage workflow, the workers should delegate too:

- Give bulk stages to a cheap model through `run_model`, and keep the current conversation for decisions that need its context.
- Route cross-model review through Baton as well. A worker that asks `gpt-5.6-sol` or `kimi-k3` to review what another model just wrote leaves a graded run behind, so the evidence accrues instead of evaporating with the subagent's transcript.
- Tell workers to grade what they actually used. A workflow that fires off a hundred delegations and grades none leaves routing exactly where it started.

When you are the callee, work within the delegated task, return a standalone answer, and stop. Do not assume access to the caller's conversation or permission to expand the task.
