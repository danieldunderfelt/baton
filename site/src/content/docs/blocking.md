---
title: "Blocking routes and scopes"
description: "Exclude routes from delegation and separate Baton's configuration scopes."
order: 6
---

Some routes are reachable and still off limits — a client's enterprise seat that happens to be logged into an app on this machine, a provider you would rather not send work to. Baton does not verify identity, so it cannot know that on its own; you tell it:

```sh
baton block add 'opencode/github-copilot/*' client enterprise subscription
baton block add 'opencode/github-copilot/<slug>'                   # just one model
baton block add cursor-agent                                       # a whole app
```

A pattern addresses a route the way Baton names one internally — `<app>[:<instance>]/<slug>`, with `*` matching anything. Leave the instance off and it covers every account; name one (`codex:work/*`) and it covers only that account. `baton block add` prints the routes it matches right now, so a typo shows up immediately.

To disable a whole app, use the same commands for built-in and registered adapters:

```sh
baton adapters disable opencode
baton adapters enable opencode
```

A blocked route is excluded from normal runs, failover, resumes and optional adapter diagnostics. `list_models` reports it as unavailable with the reason attached. `baton block list` shows route patterns and `baton block remove <pattern>` lifts one. Agents can enable or disable a whole app with `set_app_enabled(app, enabled)` through MCP. Explicit disables survive repeated registration and spec updates.

## Separate scopes

`BATON_CONFIG_DIR` separates Baton's configuration, named accounts, pools, history, ratings and sharing login. Set it per directory with [direnv](https://direnv.net) when those records should be independent. This does not isolate the underlying CLI's credentials: the default account still comes from the inherited environment, and two scopes can reach the same account. Each scope also has its own [sharing login](/docs/sharing).

Baton does not verify account ownership. It runs each CLI with the inherited environment, plus the configured overlay when a named instance is selected. Set the CLI's identity environment deliberately and use explicit blocks for accounts or providers that must never be used. An `emergency` spending preference can still select that account as a fallback.
