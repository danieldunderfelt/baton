const COMMAND_HELP: Record<string, string> = {
  mcp: "baton mcp\nRun the stdio MCP server for an agent host.",
  status: "baton status [--json]\nShow scope paths, identity environment and installed adapters.",
  detect: "baton detect\nShow installed agent CLIs, versions and reported models.",
  models: "baton models [--json]\nList models reachable in this scope, permissions and availability reasons.",
  run: "baton run <model> <prompt...> [--cwd <dir>] [--timeout <ms>]\n    [--autonomy <readonly|edits|full>] [--instance <name>] [--json]\nUse '-' as the prompt to read stdin. The answer goes to stdout; the run ID and status go to stderr.\nUse --json for the final run record. Inspect it with baton runs <run-id>.",
  resume: "baton resume <run-id> <prompt...> [--timeout <ms>]\n    [--autonomy <readonly|edits|full>] [--json]\nContinue the original session. Omitted options are inherited; explicit options apply to this turn within the configured ceiling.\nUse '-' as the prompt to read stdin.",
  runs: "baton runs [<run-id>] [--json]\nShow recent runs or inspect one run.",
  cancel: "baton cancel <run-id> [--json]\nRequest cancellation and wait for the run's processes to stop.",
  duel: "baton duel <a> <b> <prompt...> [--category <c>] [--cwd <dir>] [--timeout <ms>]\nbaton duel report <duel-id> <A|B|tie>\nbaton duel list\nCompare two answers anonymously, then record a judgment and reveal their models.",
  adapters: "baton adapters list\nbaton adapters add <spec.json>\nbaton adapters show <app>\nbaton adapters test <app|--all> [--structural]\nbaton adapters disable <app>\nbaton adapters enable <app>\nValid registered adapters are usable immediately. Tests are optional.",
  serve: "baton serve --http [--port <n>]\nRun an HTTP MCP daemon for this scope.",
  instance: "baton instance add <app> <name> --env KEY=VAL\nbaton instance list\nbaton instance remove <app> <name>\nConfigure separate accounts for an app.",
  pool: "baton pool set <app> <instance...>\nbaton pool list\nbaton pool clear <app>\nDistribute work across an app's configured accounts.",
  block: "baton block add <pattern> [reason...]\nbaton block list\nbaton block remove <pattern>\nBlock routes matching <app>[:<instance>]/<slug>. '*' matches any text; a bare app blocks all its routes.",
  ratings: "baton ratings [export|publish]\nShow observed and prior ratings. Export writes a current ratings.yaml snapshot on demand.",
  grade: "baton grade <run-id> <1-5> [notes...]\nRecord how useful a completed answer was. Repeating the command replaces its grade.",
  profile: "baton profile import <file|code|url> [--name <n>] [--activate] [--dry-run]\nbaton profile export [--profile <n>] [--out <file>]\nbaton profile share [--profile <n>]\nbaton profile shares\nbaton profile unshare <code>\nImports apply immediately. The first profile becomes active; replacements save a restorable backup.",
  login: "baton login\nSign in to the optional profile sharing service with GitHub.",
  logout: "baton logout\nSign out of the profile sharing service and revoke this device's token.",
  set: "baton set <key> <value>\nSettings: max_hops, half_life_days, profile_weight, active_profile,\n    preciousness:<app>:<instance>, max_autonomy:<app>\nChanging half_life_days with existing evidence requires --reset-evidence.",
  install: "baton install [host...] [--user] [--dir <dir>] [--no-eval]\nRegister Baton and install its skill. With no hosts, use supported host CLIs found on PATH.\nHosts: claude-code, codex, kimi, opencode, cursor-agent.\n--user installs globally; --dir selects a project directory.",
  update: "baton update\nInstall the latest release, or rebuild a checkout, and refresh existing Baton skills.\nRunning agent sessions pick up the update when restarted.",
};

export const COMMANDS = [...Object.keys(COMMAND_HELP), "upgrade"];

export const HELP = `baton: pass work between coding agents

Usage:
  baton <command> --help              Show help for one command
  baton --version                    Print the installed version
  baton install [host...] [--user]    Set up an agent host
  baton models                       Discover available models
  baton run <model> <prompt...>       Delegate a task
  baton resume <run-id> <prompt...>   Continue its session
  baton runs [<run-id>]               Inspect results
  baton cancel <run-id>               Stop a run
  baton status | detect               Inspect this scope
  baton update                        Update Baton and installed skills

More commands: mcp, serve, adapters, instance, pool, block, ratings, grade,
  profile, duel, login, logout, set.
Use 'baton help <command>' for options and examples.`;

export function helpFor(command: string): string {
  const detail = COMMAND_HELP[command === "upgrade" ? "update" : command];
  return detail ? `Usage:\n  ${detail}` : HELP;
}

export function wantsHelp(args: string[]): boolean {
  const end = args.indexOf("--");
  return args.slice(0, end < 0 ? args.length : end).some((arg) => arg === "--help" || arg === "-h");
}
