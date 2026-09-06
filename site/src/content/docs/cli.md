---
title: "CLI reference"
description: "Every baton subcommand on one page."
order: 8
---

The `baton` binary has two faces: `baton mcp` runs the MCP server over stdio that agent apps call, and `baton <subcommand>` is the CLI for humans — one-off runs, configuration, ratings, and the approval steps that should never be automated.

## Setup and inspection

| Command | What it does |
|---|---|
| `baton status` | Scope, identity env, adapter availability |
| `baton detect` | Installed agent CLIs, versions, models |
| `baton models` | Models reachable in this scope |
| `baton install [host...] [--user] [--dir <dir>] [--no-eval]` | Register Baton with agent apps |
| `baton update` | Replace this binary with the latest release |

## Running and judging

| Command | What it does |
|---|---|
| `baton run <model> <prompt...>` | Delegate once from the shell. Flags: `--cwd <dir>`, `--timeout <ms>`, `--autonomy <readonly\|edits\|full>`, `--instance <name>`; `-` as the prompt reads stdin |
| `baton resume <run-id> <prompt...>` | Continue a finished run's own session |
| `baton runs [<run-id>]` | Recent runs, or one run in detail |
| `baton duel <a> <b> <prompt...>` | Blind A/B; the outputs carry no names. Flags: `--category <c>`, `--cwd <dir>`, `--timeout <ms>` |
| `baton duel report <duel-id> <A\|B\|tie>` | Judge, then reveal which was which |
| `baton duel list` | Recent duels and their status |
| `baton grade <run-id> <1-5> [notes...]` | Grade a run after using its result |
| `baton ratings [publish]` | Show ratings, or refresh `ratings.yaml` |

## Profiles and sharing

| Command | What it does |
|---|---|
| `baton profile export [--profile <n>] [--out <file>]` | Write a profile's priors to a shareable file |
| `baton profile import <file\|code\|url> [--name <n>] [--activate] [--yes]` | Import priors from a file, share code, or URL; diff first, writes on `--yes` |
| `baton profile share [--profile <n>]` | Publish a profile to the sharing site |
| `baton profile shares` | List the profiles you have shared |
| `baton profile unshare <code>` | Revoke a share |
| `baton login` | Sign in to the sharing site with GitHub |
| `baton logout` | Forget the sharing-site token |

## Instances, pools, and blocks

| Command | What it does |
|---|---|
| `baton instance add <app> <name> --env KEY=VAL` | Define a named environment overlay for an app |
| `baton instance list` | List defined instances |
| `baton instance remove <app> <name>` | Remove an instance |
| `baton pool set <app> <instance...>` | Load-balance an app across instances |
| `baton pool list` / `baton pool clear <app>` | Show headroom and cooldowns, or remove a pool |
| `baton block add <pattern> [reason...]` | Never route to `<app>[:<instance>]/<slug>` |
| `baton block list` / `baton block remove <pattern>` | Show or lift blocks |

## Adapters

| Command | What it does |
|---|---|
| `baton adapters list` | Built-in and discovered adapters |
| `baton adapters review <app>` | The exact binary, argv and env names |
| `baton adapters approve <app> --digest <d> [--no-canary]` | Approve a reviewed spec |
| `baton adapters reject <app> [reason...]` | Discovered: a verdict on its spec; built-in: blocks every route it has |
| `baton adapters canary <app\|--all> [--structural]` | Conformance suite |

## Server and settings

| Command | What it does |
|---|---|
| `baton serve --http [--port <n>]` | HTTP MCP daemon for this scope |
| `baton set <key> <value>` | `max_hops`, `max_concurrent`, `half_life_days`, `profile_weight`, `active_profile`, `preciousness:<app>:<instance>`, `max_autonomy:<app>` |
