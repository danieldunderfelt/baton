#!/usr/bin/env bun
/**
 * baton — pass work between coding agents.
 * Two faces: `baton mcp` (stdio MCP server) and the CLI subcommands.
 */

import { COMMANDS, HELP, helpFor, wantsHelp } from "./cli/help.ts";

const argv = process.argv.slice(2);
const command = argv[0];

switch (command) {
  case "--refresh-skills": {
    if (argv.length !== 1) {
      console.error("baton: --refresh-skills takes no arguments.");
      process.exitCode = 2;
      break;
    }
    const { refreshInstalledSkills } = await import("./cli/install.ts");
    for (const path of refreshInstalledSkills()) console.log(`Refreshed skill: ${path}`);
    break;
  }
  case "mcp": {
    if (wantsHelp(argv.slice(1))) {
      console.log(helpFor("mcp"));
      break;
    }
    if (argv.length > 1) {
      console.error(`baton: mcp takes no arguments.\n\n${HELP}`);
      process.exitCode = 2;
      break;
    }
    const { serveMcp } = await import("./mcp/server.ts");
    await serveMcp();
    break;
  }
  case undefined:
  case "help":
  case "--help":
  case "-h": {
    if (command === "help" && argv[1] !== undefined && !COMMANDS.includes(argv[1])) {
      console.error(`baton: unknown command '${argv[1]}'\n\n${HELP}`);
      process.exitCode = 2;
    } else {
      console.log(command === "help" && argv[1] ? helpFor(argv[1]) : HELP);
    }
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
