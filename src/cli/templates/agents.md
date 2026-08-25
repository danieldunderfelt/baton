## Delegating through Baton

This block is shared by every agent that reads AGENTS.md here (codex, kimi, opencode). It is always in context; the tools are not. If the `baton` tools are not visible in this session, Baton was registered after it started. Tell the user to start a new session, and never shell out to `claude`, `codex`, `kimi`, `cursor-agent` or `opencode` by hand as a substitute.

{core}

### Two more things

- Send reviews out of the family, and delegate the volume. Whatever model you are, the review of what you wrote belongs on a strong model from a different family, and the mechanical half of your work belongs on a cheap one. Baton is also how you reach subscriptions this session does not have: `run_model` can put work on the user's Claude, codex or kimi quota regardless of which app you are running in.
- You are often the callee. A prompt that arrives with no conversation behind it is a delegation: answer it standalone, in the shape it asked for, touch only what it asked for, and stop. As a callee under kimi or opencode you run at full autonomy with no readonly mode available.
