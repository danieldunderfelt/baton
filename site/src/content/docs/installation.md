---
title: "Installation"
description: "Install Baton, register it with your agent apps, and keep it up to date."
order: 1
---

Install Baton once per machine:

```sh
curl -fsSL https://raw.githubusercontent.com/danieldunderfelt/baton/main/install.sh | sh
baton install --user
```

The first command puts a self-contained `baton` in `~/.local/bin` (macOS or Linux, arm64 or x64, checksum verified; no Bun needed). The second command registers Baton with the four caller hosts it finds on PATH: Claude Code, Codex, Kimi Code, and OpenCode. It writes each host's global config and the instructions that teach its agent when to delegate and how to grade what comes back.

Cursor Agent is a callee, not one of the caller hosts configured by `baton install --user`. Configure its MCP server manually if you want Cursor Agent to call Baton.

Shells use the first matching executable in `PATH`. Check which binary your shell will run with `type -a baton`, and put the user install first when needed:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Start a new agent session after installing or updating so it loads the new MCP server. A session that is already running keeps its old server.

For usage, run `baton <command> --help`. `baton --help` lists the top-level commands.

## Recovering a v0.1.0 install

The v0.1.0 release predates `install --user` and `update`. Those commands require v0.2.0 or later. Check the version and every matching executable before choosing a recovery path:

```sh
baton --version
type -a baton
```

If the binary is v0.1.0, build the current source. If a different copy appears first in `PATH`, put `~/.local/bin` first. This path requires Bun:

```sh
git clone https://github.com/danieldunderfelt/baton.git
cd baton
./install.sh
export PATH="$HOME/.local/bin:$PATH"
"$HOME/.local/bin/baton" install --user
```

After a release that includes these commands is published, rerunning the curl installer also updates the binary. Restart agent sessions after the update.

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
