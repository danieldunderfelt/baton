---
title: "Load balancing"
description: "Treat several accounts of the same app as one bigger subscription."
order: 5
---

If you have multiple accounts for the same app, Baton can distribute tasks across them. This works for apps whose adapter declares an identity environment variable, including Claude Code (`CLAUDE_CONFIG_DIR`), Codex (`CODEX_HOME`), Kimi Code (`KIMI_CODE_HOME`) and OpenCode (`XDG_DATA_HOME`). Registered adapters can declare one too. Log the second account in once, tell Baton about it, and pool them:

```sh
CLAUDE_CONFIG_DIR=~/.claude2 claude    # log in once, interactively
baton instance add claude-code personal-2 --env CLAUDE_CONFIG_DIR=~/.claude2
baton pool set claude-code default personal-2
```

An instance is a named environment overlay for an app — the extra variables Baton sets when it spawns that account's CLI. A pool is the set of instances an app load-balances across. `baton instance list` shows what is defined; `baton pool set <app> <instance...>` replaces a pool, `baton pool clear <app>` removes it.

Catalog discovery uses each account's effective environment, so a model offered by one account does not make that model available on another. Resumes stay attached to the account that holds the session, including after an earlier run failed over.

## How runs are routed

From then on every delegation to a model that app serves picks an account automatically:

- Selection favours the less-used account based on runs Baton observed in the last five hours and seven days. This estimates relative headroom; it does not read subscription limits or usage outside Baton.
- An admission failure puts the account into an exponential cooldown backoff, and the run retries on the next account under the same run id.
- Failover only happens when the refusal provably came before any work started. If a failure happens after work may have begun, Baton fails the run instead of silently re-running it, because the first attempt may have edited files.
- Resumed runs skip the pool and go back to the account that holds the session.

`baton pool list` shows the live picture: headroom per account and who is cooling down.

## Spending policy per account

```sh
baton set preciousness:claude-code:personal-2 conserve
```

Levels are `burn`, `conserve`, and `emergency`. An `emergency` account is reserved for fallback selection. It can still be used when other candidates are unavailable. Use an explicit [route block](/docs/blocking) when an account must never be used in a scope.
