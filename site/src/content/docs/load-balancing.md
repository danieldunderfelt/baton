---
title: "Load balancing"
description: "Treat several accounts of the same app as one bigger subscription."
order: 5
---

If you have two subscriptions for the same app, Baton can treat them as one bigger one. This works for any app whose account follows an environment variable: Claude Code (`CLAUDE_CONFIG_DIR`), Codex (`CODEX_HOME`), and Kimi Code (`KIMI_CODE_HOME`). Log the second account in once, tell Baton about it, and pool them:

```sh
CLAUDE_CONFIG_DIR=~/.claude2 claude    # log in once, interactively
baton instance add claude-code personal-2 --env CLAUDE_CONFIG_DIR=~/.claude2
baton pool set claude-code default personal-2
```

An instance is a named environment overlay for an app — the extra variables Baton sets when it spawns that account's CLI. A pool is the set of instances an app load-balances across. `baton instance list` shows what is defined; `baton pool set <app> <instance...>` replaces a pool, `baton pool clear <app>` removes it.

## How runs are routed

From then on every delegation to a model that app serves picks an account automatically:

- Selection favours the account with the most quota headroom, so both usage windows stay warm instead of one draining while the other sits idle. Subscription quota comes in rolling windows; two accounts drained evenly get you more work per day than two drained in sequence.
- An account that hits a rate limit before starting work goes into cooldown — until the provider's stated reset when one is given, with growing backoff otherwise — and the run retries on the next account under the same run id.
- Failover only happens when the refusal provably came before any work started. If a failure happens after work may have begun, Baton fails the run instead of silently re-running it, because the first attempt may have edited files.
- Resumed runs skip the pool and go back to the account that holds the session.

`baton pool list` shows the live picture: headroom per account and who is cooling down.

## Spending policy per account

```sh
baton set preciousness:claude-code:personal-2 conserve
```

Levels are `burn`, `conserve`, and `emergency`. An `emergency` account is only picked when every other account is unavailable, which is how "keep the work account out of my hobby projects" becomes one line of config.
