import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Logger = {
  log: (...parts: unknown[]) => void;
  error: (...parts: unknown[]) => void;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type ReleaseOptions = {
  cwd?: string;
  argv?: string[];
  bunExecutable?: string;
  env?: Record<string, string>;
  logger?: Logger;
};

type ReleasePackage = {
  text: string;
  version: string;
};

const HELP = `Usage: bun run release <X.Y.Z> [--dry-run]

Release the next stable Baton version from a clean, up-to-date main branch.

Options:
  --dry-run  Validate version, Git state, remote state, and tag availability
  --help     Show this help`;

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function defaultLogger(): Logger {
  return { log: console.log, error: console.error };
}

function commandText(command: string, args: string[]): string {
  return [command, ...args]
    .map((part) => (/^[\w./:@=-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`))
    .join(" ");
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): CommandResult {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    env,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function requireSuccess(result: CommandResult, command: string, args: string[]): CommandResult {
  if (result.exitCode !== 0) {
    const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    throw new Error(`${commandText(command, args)} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result;
}

function parseStableVersion(value: string, label: string): [number, number, number] {
  const normalized = value.startsWith("v") ? value.slice(1) : value;
  const match = STABLE_VERSION.exec(normalized);
  if (!match) throw new Error(`${label} must be a stable X.Y.Z version, got '${value}'`);
  const parts: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!parts.every(Number.isSafeInteger))
    throw new Error(`${label} has a component that is too large`);
  return parts;
}

function compareVersions(left: [number, number, number], right: [number, number, number]): number {
  if (left[0] !== right[0]) return left[0] > right[0] ? 1 : -1;
  if (left[1] !== right[1]) return left[1] > right[1] ? 1 : -1;
  if (left[2] !== right[2]) return left[2] > right[2] ? 1 : -1;
  return 0;
}

function readReleasePackage(cwd: string): ReleasePackage {
  const text = readFileSync(join(cwd, "package.json"), "utf8");
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
    throw new Error("package.json has no version field");
  }
  const version = parsed.version;
  if (typeof version !== "string") throw new Error("package.json version must be a string");
  parseStableVersion(version, "package.json version");
  return { text, version };
}

function replacePackageVersion(text: string, version: string): string {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
    throw new Error("package.json has no version field");
  }
  parsed.version = version;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function firstRemoteHash(output: string): string | undefined {
  const line = output.split("\n").find((candidate) => candidate.trim().length > 0);
  return line?.trim().split(/\s+/)[0];
}

function githubRepository(remote: string): string | undefined {
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function statusPaths(status: string): string[] {
  return status
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));
}

function isOnlyPackageChange(status: string): boolean {
  const paths = statusPaths(status);
  return paths.length === 1 && paths[0] === "package.json";
}

function printCommand(logger: Logger, command: string, args: string[]): void {
  logger.log(`> ${commandText(command, args)}`);
}

function checkedCommand(
  logger: Logger,
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): CommandResult {
  printCommand(logger, command, args);
  const result = runCommand(command, args, cwd, env);
  if (result.stdout.trim()) logger.log(result.stdout.trimEnd());
  if (result.stderr.trim()) logger.error(result.stderr.trimEnd());
  return requireSuccess(result, command, args);
}

function gitCommand(
  cwd: string,
  env: Record<string, string>,
  args: string[],
  allowFailure = false,
): CommandResult {
  const result = runCommand("git", args, cwd, env);
  if (!allowFailure) requireSuccess(result, "git", args);
  return result;
}

function restorePackageIfSafe(
  cwd: string,
  env: Record<string, string>,
  originalText: string,
  plannedText: string,
  logger: Logger,
): void {
  if (readFileSync(join(cwd, "package.json"), "utf8") !== plannedText) {
    logger.error(
      "package.json changed during validation; preserving those edits. Review git diff and undo only the release version change before retrying.",
    );
    return;
  }
  gitCommand(cwd, env, ["restore", "--staged", "--", "package.json"]);
  writeFileSync(join(cwd, "package.json"), originalText);
  logger.log("Restored package.json to its original version.");
}

type ParsedArguments = { kind: "help" } | { kind: "release"; version: string; dryRun: boolean };

function parseArguments(argv: string[]): ParsedArguments {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { kind: "help" };
  }
  let dryRun = false;
  let version: string | undefined;
  for (const arg of argv) {
    if (arg === "--dry-run") {
      if (dryRun) throw new Error("--dry-run may only be specified once");
      dryRun = true;
    } else if (version === undefined) {
      version = arg;
    } else {
      throw new Error(`unexpected argument '${arg}'`);
    }
  }
  if (version === undefined) throw new Error("release needs a version, for example 0.3.0");
  return { kind: "release", version, dryRun };
}

export function runRelease(options: ReleaseOptions = {}): number {
  const cwd = options.cwd ?? process.cwd();
  const logger = options.logger ?? defaultLogger();
  const argv = options.argv ?? process.argv.slice(2);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, options.env);
  // Releasing validates the artifact without spending agent subscriptions.
  env.BATON_LIVE_TESTS = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  const bun = options.bunExecutable ?? process.execPath;

  let parsedArgs: ParsedArguments;
  try {
    parsedArgs = parseArguments(argv);
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (parsedArgs.kind === "help") {
    logger.log(HELP);
    return 0;
  }

  const normalizedVersion = parsedArgs.version.startsWith("v")
    ? parsedArgs.version.slice(1)
    : parsedArgs.version;
  let version: [number, number, number];
  let releasePackage: ReleasePackage;
  try {
    version = parseStableVersion(parsedArgs.version, "release version");
    releasePackage = readReleasePackage(cwd);
    if (
      compareVersions(
        version,
        parseStableVersion(releasePackage.version, "package.json version"),
      ) <= 0
    ) {
      throw new Error(
        `release version ${normalizedVersion} must be newer than package.json ${releasePackage.version}`,
      );
    }
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const gitEnv = env;
  const tag = `v${normalizedVersion}`;
  let stage: "preflight" | "versioned" | "committed" | "tagging" | "tagged" = "preflight";
  let originalHead = "";
  let releaseCommit = "";
  const plannedText = replacePackageVersion(releasePackage.text, normalizedVersion);
  try {
    const status = gitCommand(cwd, gitEnv, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]).stdout;
    if (status.trim()) throw new Error("working tree must be clean, including untracked files");
    if (gitCommand(cwd, gitEnv, ["branch", "--show-current"]).stdout.trim() !== "main") {
      throw new Error("release must run from the main branch");
    }
    const remote = gitCommand(cwd, gitEnv, [
      "remote",
      "get-url",
      "--push",
      "--all",
      "origin",
    ]).stdout.trim();
    if (remote.includes("\n")) throw new Error("origin must have exactly one push destination");

    const head = gitCommand(cwd, gitEnv, ["rev-parse", "HEAD"]).stdout.trim();
    originalHead = head;
    const localTag = gitCommand(
      cwd,
      gitEnv,
      ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`],
      true,
    );
    if (localTag.exitCode === 0) throw new Error(`tag ${tag} already exists locally`);

    const remoteTag = gitCommand(cwd, gitEnv, [
      "ls-remote",
      "--refs",
      "--",
      remote,
      `refs/tags/${tag}`,
    ]);
    if (firstRemoteHash(remoteTag.stdout) !== undefined)
      throw new Error(`tag ${tag} already exists on origin`);

    const remoteMain = firstRemoteHash(
      gitCommand(cwd, gitEnv, ["ls-remote", "--heads", "--", remote, "refs/heads/main"]).stdout,
    );
    if (remoteMain === undefined) throw new Error("origin has no main branch");
    if (remoteMain !== head)
      throw new Error(
        "local HEAD must equal origin/main on the remote; commit and push your changes first",
      );

    if (parsedArgs.dryRun) {
      logger.log(`Dry run passed. Would release ${tag} from ${head}.`);
      logger.log(
        "Planned actions: bump package.json, install locked dependencies, typecheck/build/test the native binary, run release smoke checks and website checks/tests/build, commit package.json, create an annotated tag, and push both refs atomically.",
      );
      return 0;
    }

    stage = "versioned";
    writeFileSync(join(cwd, "package.json"), plannedText);

    const rootSteps: string[][] = [
      ["install", "--frozen-lockfile"],
      ["run", "check"],
      ["run", "build"],
      ["run", "test"],
      ["run", "check:release"],
    ];
    for (const args of rootSteps) checkedCommand(logger, bun, args, cwd, env);

    const site = join(cwd, "site");
    const siteSteps: string[][] = [
      ["install", "--frozen-lockfile"],
      ["run", "check"],
      ["run", "test"],
      ["run", "build"],
    ];
    for (const args of siteSteps) checkedCommand(logger, bun, args, site, env);

    const afterChecks = gitCommand(cwd, gitEnv, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]).stdout;
    if (!isOnlyPackageChange(afterChecks)) {
      throw new Error("validation changed files besides package.json; refusing to commit");
    }
    if (
      readFileSync(join(cwd, "package.json"), "utf8") !== plannedText ||
      gitCommand(cwd, gitEnv, ["rev-parse", "HEAD"]).stdout.trim() !== head ||
      gitCommand(cwd, gitEnv, ["branch", "--show-current"]).stdout.trim() !== "main"
    ) {
      throw new Error("release inputs changed during validation; refusing to commit");
    }

    checkedCommand(logger, "git", ["add", "--", "package.json"], cwd, gitEnv);
    const staged = gitCommand(cwd, gitEnv, ["diff", "--cached", "--name-only"]).stdout;
    if (staged.trim() !== "package.json")
      throw new Error("refusing to commit files besides package.json");
    checkedCommand(logger, "git", ["commit", "-m", `Release ${tag}`], cwd, gitEnv);
    stage = "committed";
    releaseCommit = gitCommand(cwd, gitEnv, ["rev-parse", "HEAD"]).stdout.trim();
    if (
      gitCommand(cwd, gitEnv, ["show", "HEAD:package.json"]).stdout !== plannedText ||
      gitCommand(cwd, gitEnv, ["rev-parse", "HEAD^"]).stdout.trim() !== head ||
      gitCommand(cwd, gitEnv, ["diff", "HEAD^", "HEAD", "--name-only"]).stdout.trim() !==
        "package.json" ||
      gitCommand(cwd, gitEnv, ["status", "--porcelain=v1", "--untracked-files=all"]).stdout.trim()
    ) {
      throw new Error(
        "release commit or working tree differs from what was validated; inspect it before tagging",
      );
    }
    stage = "tagging";
    checkedCommand(
      logger,
      "git",
      ["tag", "-a", tag, releaseCommit, "-m", `Release ${tag}`],
      cwd,
      gitEnv,
    );
    stage = "tagged";

    const pushArgs = [
      "push",
      "--atomic",
      "--no-follow-tags",
      "origin",
      `${releaseCommit}:refs/heads/main`,
      `refs/tags/${tag}`,
    ];
    const push = runCommand("git", pushArgs, cwd, gitEnv);
    if (push.stdout.trim()) logger.log(push.stdout.trimEnd());
    if (push.stderr.trim()) logger.error(push.stderr.trimEnd());
    requireSuccess(push, "git", pushArgs);

    const repository = githubRepository(remote);
    logger.log(`Release ${tag} pushed atomically. CI publication is pending.`);
    if (repository) {
      logger.log(`GitHub Actions: https://github.com/${repository}/actions/workflows/release.yml`);
      logger.log(`GitHub release: https://github.com/${repository}/releases/tag/${tag}`);
      logger.log(`Optional: gh run watch --repo ${repository}`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (stage === "preflight" || stage === "versioned") {
      try {
        if (
          stage === "versioned" &&
          gitCommand(cwd, gitEnv, ["rev-parse", "HEAD"]).stdout.trim() === originalHead
        ) {
          restorePackageIfSafe(cwd, gitEnv, releasePackage.text, plannedText, logger);
        }
      } catch (restoreError) {
        logger.error(
          `Could not restore package.json automatically: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
        );
      }
      logger.error(`Release failed before commit: ${message}`);
    } else if (stage === "committed" || stage === "tagging") {
      logger.error(
        `Release commit created locally, but tag ${tag} was not created. The release is not published.`,
      );
      logger.error(
        `Inspect the commit and fix the reported problem before tagging ${releaseCommit}.`,
      );
      if (stage === "tagging") {
        logger.error(
          `After fixing signing: ${commandText("git", ["tag", "-a", tag, releaseCommit, "-m", `Release ${tag}`])}`,
        );
        logger.error(
          `Then: git push --atomic --no-follow-tags origin ${releaseCommit}:refs/heads/main refs/tags/${tag}`,
        );
      }
      logger.error(message);
    } else {
      const retry = `git push --atomic --no-follow-tags origin ${releaseCommit}:refs/heads/main refs/tags/${tag}`;
      logger.error(
        `Release push failed. The local release commit and tag were kept. Publication is unconfirmed; check the remote before retrying.`,
      );
      logger.error(`Retry with: ${retry}`);
      logger.error(message);
    }
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = runRelease();
}
