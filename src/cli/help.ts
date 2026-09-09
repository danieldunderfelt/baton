export const HELP = `baton — pass work between coding agents

Usage:
  baton --help | help [command]           Show usage without changing anything
  baton --version                         Print the installed version
  baton mcp                               Run the stdio MCP server
  baton status                            Scope, identity env, adapter availability
  baton detect                            Installed agent CLIs, versions, models
  baton models                            Models reachable in this scope
  baton run <model> <prompt...>           Delegate once from the shell
      --cwd <dir> --timeout <ms> --autonomy <readonly|edits|full>
      --instance <name>                   ('-' as the prompt reads stdin)
  baton resume <run-id> <prompt...>       Continue a finished run's own session
  baton runs [<run-id>]                   Recent runs, or one run in detail
  baton duel <a> <b> <prompt...>          Blind A/B; the outputs carry no names
      --category <c> --cwd <dir> --timeout <ms>
  baton duel report <duel-id> <A|B|tie>   Judge, then reveal which was which
  baton duel list                         Recent duels and their status
  baton adapters list                     Built-in and discovered adapters
  baton adapters review <app>             The exact binary, argv and env names
  baton adapters approve <app> --digest <d> [--no-canary]
  baton adapters reject <app> [reason...]  Discovered: a verdict on its spec
                                          Built-in: blocks every route it has
  baton adapters canary <app|--all> [--structural]   Conformance suite
  baton serve --http [--port <n>]         HTTP MCP daemon for this scope
  baton instance add <app> <name> --env KEY=VAL
  baton instance list
  baton instance remove <app> <name>
  baton pool set <app> <instance...>      Load-balance an app across instances
  baton pool list | pool clear <app>
  baton block add <pattern> [reason...]   Never route to <app>[:<instance>]/<slug>
      e.g. 'opencode/github-copilot/*'    ('*' wildcards; bare app blocks it all)
  baton block list | block remove <pattern>
  baton ratings [publish]                 Show ratings, or refresh ratings.yaml
  baton grade <run-id> <1-5> [notes...]   Grade a run after using its result
  baton profile import <file|code|url> [--name <n>] [--activate] [--yes]
  baton profile export [--profile <n>] [--out <file>]
  baton profile share [--profile <n>]     Publish to the sharing site; prints code and link
  baton profile shares | profile unshare <code>
  baton login | logout                    Sign in to the sharing site with GitHub
  baton set <key> <value>                 Settings: max_hops, max_concurrent, half_life_days, profile_weight, active_profile,
      preciousness:<app>:<instance>, max_autonomy:<app>
  baton install [host...] [--user] [--dir <dir>] [--no-eval]
                                          No host: every host CLI on PATH. --user: global configs
  baton update                            Replace this binary with the latest release
      hosts: claude-code, codex, kimi, opencode
`;

export const COMMANDS = [
  "mcp",
  "status",
  "detect",
  "models",
  "run",
  "resume",
  "runs",
  "duel",
  "adapters",
  "serve",
  "instance",
  "pool",
  "block",
  "ratings",
  "profile",
  "login",
  "logout",
  "grade",
  "set",
  "install",
  "update",
  "upgrade",
];

export function wantsHelp(args: string[]): boolean {
  const end = args.indexOf("--");
  return args.slice(0, end < 0 ? args.length : end).some((arg) => arg === "--help" || arg === "-h");
}
