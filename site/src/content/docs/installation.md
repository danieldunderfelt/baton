---
title: "Installation"
description: "Install Baton, register it with your agent apps, and keep it up to date."
order: 1
---

Installation is two commands, once per machine:

```sh
curl -fsSL https://raw.githubusercontent.com/danieldunderfelt/baton/main/install.sh | sh
baton install --user
```

The first puts a self-contained `baton` in `~/.local/bin` (macOS or Linux, arm64 or x64, checksum verified; no Bun needed). The second registers Baton with every supported agent app found on PATH — Claude Code, Codex, Kimi Code, OpenCode — in each app's own global config, and writes the instructions that teach its agent when to delegate and how to grade what comes back. Start a new session in any app and the `baton` tools are there.

## Single checkout

To keep an install inside one checkout instead of the whole machine, run `baton install` in that directory. It writes `.mcp.json`, `.codex/config.toml`, `opencode.json` and the instruction files there instead of in the global configs.

```sh
baton install claude-code codex    # only these hosts
baton install --dir ~/work/other   # install into another directory
baton install --no-eval            # leave out the grading instructions
```

Host names limit which apps get registered. `--no-eval` leaves out the grading section of the instructions; the default includes it, because ratings do not improve without grades.

## Updating

```sh
baton update
```

This replaces the binary with the latest release, or rebuilds it if you run from a checkout. Sessions already running keep the old server until they restart.

## Checking what is there

- `baton detect` shows which agent CLIs are installed, their versions, and which models they serve.
- `baton status` shows where Baton's state lives and which identity environment variables are set.

## Building from a checkout

Clone the repo, install [Bun](https://bun.sh), and run `./install.sh` — it builds from source into `~/.local/bin`. `bun run build:all` builds every release target; a version tag matching `package.json` publishes them with a `SHA256SUMS` file through GitHub Actions.

There is no Windows build: Baton's process-tree cleanup relies on POSIX process groups.
