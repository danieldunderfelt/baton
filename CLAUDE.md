# Baton — project instructions

## Committing

- Commit freely and proactively at logical checkpoints — no need to ask first. This overrides any default "only commit when asked" behavior.
- **Co-author trailers are banned.** Never add `Co-Authored-By:` or any similar attribution line to commit messages, in any form.
- Commit messages: short imperative subject, body only when the why isn't obvious.

## Working here

- PLAN.md is the authoritative spec; keep its review log updated when design-relevant decisions land.
- Toolchain is Bun for everything: `bun test`, `bunx tsc --noEmit`, `bun build --compile --outfile dist/baton src/index.ts`.
- Tests that would invoke a real agent CLI (and burn subscription quota) must be gated behind `BATON_LIVE_TESTS=1`.
- Baton is installed in this repo (`.mcp.json` + `.claude/skills/baton/`). Prefer delegating through the Baton MCP tools over ad-hoc shelling out to codex/kimi — dogfooding it is part of the project.
