---
title: "CLI reference"
description: "Every baton subcommand on one page."
order: 8
---

`baton mcp` runs the stdio MCP server that agent apps call. The other commands run tasks, inspect results and configure Baton from the shell. Use `baton <command> --help` for focused help without executing the command.

## Setup and inspection

| Command | What it does |
|---|---|
| `baton --help` | Show top-level usage and commands |
| `baton help [command]` | Show usage for a command |
| `baton <command> --help` | Show usage for a command |
| `baton --version` | Print the installed version |
| `baton status [--json]` | Scope, identity env, adapter availability |
| `baton detect` | Installed agent CLIs, versions, models |
| `baton models [--json]` | Models reachable in this scope, supported permissions and availability reasons |
| `baton install [host...] [--user] [--dir <dir>] [--no-eval]` | Register Baton with agent apps |
| `baton update` | Update the binary, or rebuild a checkout, and refresh tracked Baton skills |

`baton install` supports Claude Code, Codex, Kimi Code, OpenCode, and Cursor Agent. With no host names it registers every supported CLI found on `PATH`; name hosts to select them explicitly. Codex, Kimi, OpenCode, and Cursor share `.agents/skills/baton/SKILL.md` at the nearest Git root or target directory without one. Claude gets the same skill in `.claude/skills/baton/SKILL.md`. `--user` installs in the corresponding home directories. `--no-eval` omits the optional ratings appendix.

Installing a host that uses the shared skill also removes complete standalone Baton blocks from its old `AGENTS.md`, preserving surrounding content. A Claude-only install leaves that file alone. Fresh installs do not create `AGENTS.md`; malformed marker pairs stop migration for that host before its files are written.

## Running and judging

| Command | What it does |
|---|---|
| `baton run <model> <prompt...> [--json]` | Delegate once. Flags: `--cwd <dir>`, `--timeout <ms>`, `--autonomy <readonly\|edits\|full>`, `--instance <name>`; `-` as the prompt reads stdin |
| `baton resume <run-id> <prompt...> [--json]` | Continue the original session. Accepts `--timeout <ms>` and `--autonomy <readonly\|edits\|full>`; omitted options are inherited |
| `baton runs [<run-id>] [--json]` | Recent runs, or one run in detail |
| `baton cancel <run-id> [--json]` | Request cancellation and wait for the run's processes to stop |
| `baton duel <a> <b> <prompt...>` | Blind A/B; the outputs carry no names. Flags: `--category <c>`, `--cwd <dir>`, `--timeout <ms>` |
| `baton duel report <duel-id> <A\|B\|tie>` | Judge, then reveal which was which |
| `baton duel list` | Recent duels and their status |
| `baton grade <run-id> <1-5> [notes...]` | Grade a run after using its result |
| `baton ratings` | Show current ratings from SQLite |
| `baton ratings export` | Write a `ratings.yaml` snapshot on demand; `publish` remains an alias |

`run` and `resume` print answers to stdout, with run IDs, resolved options and status on stderr. `--json` prints the final run record, including `options`. Explicit resume options apply to the new turn within the current autonomy ceiling. The CLI waits for runs it starts; use MCP `wait: false` for asynchronous delegation.

## Profiles and sharing

| Command | What it does |
|---|---|
| `baton profile export [--profile <n>] [--out <file>]` | Write a profile's priors to a shareable file |
| `baton profile import <file\|code\|url> [--name <n>] [--activate] [--dry-run]` | Import immediately; `--dry-run` previews without changing priors |
| `baton profile share [--profile <n>]` | Publish a profile to the sharing site |
| `baton profile shares` | List your shared profiles, fetching all result pages |
| `baton profile unshare <code>` | Revoke a share |
| `baton login` | Sign in to the sharing site with GitHub |
| `baton logout` | Remove the sharing token and revoke it on the server |

The first imported profile activates automatically. Later imports keep the active profile unless `--activate` is supplied. Replacements save a backup and print a restore command. `--yes` is accepted for older scripts but is no longer required.

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
| `baton adapters list` | Built-in and registered adapters, with enabled/disabled status |
| `baton adapters add <spec.json>` | Validate and register an adapter for immediate use |
| `baton adapters show <app>` | Print the adapter spec |
| `baton adapters enable <app>` | Enable a built-in or registered adapter |
| `baton adapters disable <app>` | Disable a built-in or registered adapter |
| `baton adapters test <app\|--all> [--structural]` | Run optional diagnostics; `--structural` validates declarations without executing the app |

Registration makes no model call. Diagnostics obey blocks and permission ceilings and do not change enabled status. There are no adapter approval commands.

## Server and settings

| Command | What it does |
|---|---|
| `baton mcp` | Run the stdio MCP server |
| `baton serve --http [--port <n>]` | HTTP MCP daemon for this scope |
| `baton set <key> <value>` | `max_hops`, `half_life_days`, `profile_weight`, `active_profile`, `preciousness:<app>:<instance>`, `max_autonomy:<app>` |

Changing `half_life_days` after evidence has accumulated requires `--reset-evidence`. This discards rating aggregates under the old decay setting, while retaining run and grade history.

## MCP equivalents

Use `list_models`, `run_model`, `get_run`, `resume_run` and `cancel_run` for delegation. `cancel_run` can return a pending state; `get_run` waits for completion. `discover_app` describes adapter registration, `register_app` stores a spec, `test_app` runs an optional diagnostic and `set_app_enabled` enables or disables an adapter. `report_result`, `run_duel`, `report_duel` and `seed_ratings` provide optional evaluation tools.
