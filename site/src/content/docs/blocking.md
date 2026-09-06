---
title: "Blocking routes and scopes"
description: "Keep routes you must not spend out of rotation, and keep separate worlds separate."
order: 6
---

Some routes are reachable and still off limits — a client's enterprise seat that happens to be logged into an app on this machine, a provider you would rather not send work to. Baton does not verify identity, so it cannot know that on its own; you tell it:

```sh
baton block add 'opencode/github-copilot/*' client enterprise subscription
baton block add 'opencode/github-copilot/<slug>'                   # just one model
baton block add cursor-agent                                       # a whole app
```

A pattern addresses a route the way Baton names one internally — `<app>[:<instance>]/<slug>`, with `*` matching anything. Leave the instance off and it covers every account; name one (`codex:work/*`) and it covers only that account. `baton block add` prints the routes it matches right now, so a typo shows up immediately.

To take a whole app out of service, reject it — this works on the built-in apps too, not just discovered ones:

```sh
baton adapters reject opencode client machine   # blocks every route it has
baton block remove 'opencode:*/*'               # and back again
```

A blocked route is never selected: not when it is the only route for a model, not as a last resort when everything else is rate-limited, not when resuming a session that already ran on it, and not by the conformance canary. `list_models` reports it as unavailable with your reason attached, so a delegating agent sees the refusal before it tries. Blocks are written only from your terminal — `baton block list` shows them, `baton block remove <pattern>` lifts one — never through an MCP tool.

## Separate worlds

`BATON_CONFIG_DIR` relocates everything Baton knows: config, accounts, pools, quota history, ratings, the database. Set it per directory with [direnv](https://direnv.net) and a work checkout gets a Baton that only knows work accounts, while your personal projects get another that only knows personal ones. The two cannot leak into each other because neither knows the other exists. Each scope also has its own sharing login (see [Sharing profiles](/docs/sharing)).

Baton never inspects or enforces identity. It runs each CLI with the environment it inherited, exactly as if you had typed the command in that shell. Whatever account the environment supplies is the account that runs.
