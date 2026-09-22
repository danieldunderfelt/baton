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

The first command puts a self-contained `baton` in `~/.local/bin` (macOS or Linux, arm64 or x64, checksum verified; no Bun needed). The second command registers Baton with the five caller hosts it finds on `PATH`: Claude Code, Codex, Kimi Code, OpenCode, and Cursor Agent. It writes each host's global config and the same on-demand skill. You can then discover models and delegate without a rating interview or adapter approval step.

Shells use the first matching executable in `PATH`. Check which binary your shell will run with `type -a baton`, and put the user install first when needed:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Start a new agent session after installing or updating so it loads the new MCP server. A session that is already running keeps its old server.

For usage, run `baton <command> --help`. `baton --help` lists the top-level commands.

## Single checkout

To keep an install inside one checkout instead of the whole machine, run `baton install` in that directory. It writes the selected hosts' MCP files and the same `SKILL.md` content at each host's discovery path.

```sh
baton install claude-code codex    # only these hosts
baton install --dir ~/work/other   # install into another directory
baton install --no-eval            # leave out the grading instructions
```

Host names limit which apps get registered. `--no-eval` leaves out the optional ratings appendix. Reinstalling updates the MCP registration and skill. For hosts using the shared skill, it also removes complete standalone `<!-- baton:begin -->` … `<!-- baton:end -->` blocks from the old `AGENTS.md`, preserving the surrounding file. A Claude-only install leaves that file alone. Fresh installs do not create `AGENTS.md`; incomplete or nested markers stop migration for that host before its files are written.

Baton-only regular files are removed after migration; symlinks stay intact.

## Discovery paths

Codex, Kimi, OpenCode, and Cursor share one skill at `.agents/skills/baton/SKILL.md`. Project installs place it at the nearest Git root, or the target directory when there is no Git root. User installs place it at `~/.agents/skills/baton/SKILL.md`. Claude gets the same content in `.claude/skills/baton/SKILL.md` (project) or `~/.claude/skills/baton/SKILL.md` (user).

| Host | Project MCP config | User MCP config |
|---|---|---|
| Claude Code | `.mcp.json` | `~/.claude.json` |
| Codex | `.codex/config.toml` | `~/.codex/config.toml` |
| Kimi Code | `.mcp.json` when the target is a Git root; otherwise `.kimi-code/mcp.json` | `~/.kimi-code/mcp.json` |
| OpenCode | `opencode.json` or existing `opencode.jsonc` | `~/.config/opencode/opencode.json` or existing `opencode.jsonc` |
| Cursor Agent | `.cursor/mcp.json` | `~/.cursor/mcp.json` |

`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `KIMI_CODE_HOME`, and `XDG_CONFIG_HOME` relocate their corresponding user MCP configs; `OPENCODE_CONFIG` selects OpenCode's MCP config file. Claude's skill also follows `CLAUDE_CONFIG_DIR`. The shared skill stays in `~/.agents/skills` regardless of these overrides. Cursor may prompt you to approve Baton; you can also run `cursor-agent mcp enable baton`.

## Updating

```sh
baton update
```

This replaces the binary with the latest release, or rebuilds it if you run from a checkout. Sessions already running keep the old server until they restart.

Successful updates also refresh existing Baton-owned skills recorded by `baton install`, using templates from the updated executable. Host MCP configuration and unrelated instructions are preserved, as is the choice to omit the ratings appendix. Missing or unrelated skill files are not created or replaced.

`installed-skills.json` in Baton's config directory records installation paths for future updates. Older generated skills in the current project and configured home locations are also recognized. An older installation in another project needs one `baton install` from that project, or `baton install --dir <project>`, to enter the manifest. Use the same `BATON_CONFIG_DIR` scope when installing and updating those skills.

## Checking what is there

- `baton detect` shows which agent CLIs are installed, their versions, and which models they serve.
- `baton status` shows where Baton's state lives and which identity environment variables are set.

## Building from a checkout

Clone the repo, install [Bun](https://bun.sh), and run `./install.sh` to build from source into `~/.local/bin`. Maintainers can publish a version with `bun run release <version>`; see [Releasing](/docs/releasing) for the procedure.

There is no Windows build: Baton's process-tree cleanup relies on POSIX process groups.

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
