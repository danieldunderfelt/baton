#!/usr/bin/env bun
/**
 * baton — pass work between coding agents.
 * Two faces: `baton mcp` (stdio MCP server) and the CLI subcommands.
 */

const argv = process.argv.slice(2);
const command = argv[0];

switch (command) {
  case "mcp": {
    const { serveMcp } = await import("./mcp/server.ts");
    await serveMcp();
    break;
  }
  case undefined:
  case "help":
  case "--help":
  case "-h": {
    printHelp();
    break;
  }
  case "--version":
  case "-v": {
    const pkg = await import("../package.json");
    console.log(pkg.version);
    break;
  }
  default: {
    const { runCli } = await import("./cli/cli.ts");
    process.exitCode = await runCli(command, argv.slice(1));
  }
}

function printHelp(): void {
  console.log(`baton — pass work between coding agents

Usage:
  baton mcp                      Run the stdio MCP server (register via 'baton install')
  baton serve --http [--port <n>]  Run the HTTP MCP daemon for this scope
  baton detect                   Detect installed agent CLIs and adapter health
  baton models                   List available models in this scope
  baton run <model> <prompt>     Run a one-off delegation from the shell
  baton resume <run-id> <prompt> Continue a finished run's own session
  baton runs [<run-id>]          Show recent runs / one run's detail
  baton duel <a> <b> <prompt>    Blind A/B between two models (report to judge)
  baton adapters <list|review|approve|reject|canary> ...   Adapters and discovery
  baton instance <add|list|remove> ...   Manage named app instances
  baton pool <set|list|clear> ...        Load-balance an app across instances
  baton ratings [publish]        Show model ratings / refresh ratings.yaml
  baton grade <run-id> <1-5>     Grade a run after using its result
  baton profile import <file>    Import a shared priors profile (--yes to commit)
  baton profile export           Print the active profile as a portable file
  baton set <key> <value>        Set a scope setting (e.g. max_autonomy:codex full)
  baton install [host...]        Register Baton with the host apps on PATH (--user: once, globally)
  baton update                   Replace this binary with the latest release
  baton status                   Show scope, resolved identity env vars, DB path
`);
}
