import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runRelease } from "../scripts/release.ts";

type Fixture = {
  repo: string;
  bare: string;
  fakeBun: string;
  log: string;
  originalPackage: string;
};

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function command(cwd: string, args: string[], allowFailure = false): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!allowFailure && result.exitCode !== 0) {
    throw new Error(`${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

function fixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "baton-release-test-"));
  temporaryDirectories.push(directory);
  const repo = join(directory, "repo");
  const bare = join(directory, "origin.git");
  mkdirSync(repo);
  command(directory, ["init", "--bare", bare]);
  command(repo, ["init", "-b", "main"]);
  command(repo, ["config", "user.name", "Release Test"]);
  command(repo, ["config", "user.email", "release-test@example.test"]);
  command(repo, ["config", "commit.gpgsign", "false"]);
  command(repo, ["config", "tag.gpgsign", "false"]);
  command(repo, ["config", "core.hooksPath", join(directory, "empty-hooks")]);
  command(repo, ["remote", "add", "origin", bare]);
  writeFileSync(join(repo, "package.json"), '{\n  "name": "fixture",\n  "version": "0.2.0"\n}\n');
  writeFileSync(join(repo, "bun.lock"), "fixture lock\n");
  mkdirSync(join(repo, "site"));
  writeFileSync(join(repo, "site", "package.json"), '{\n  "name": "fixture-site"\n}\n');
  writeFileSync(join(repo, "site", "bun.lock"), "fixture site lock\n");
  command(repo, ["add", "."]);
  command(repo, ["commit", "-m", "Initial fixture"]);
  command(repo, ["push", "-u", "origin", "main"]);
  command(repo, ["fetch", "origin", "main"]);

  const fakeBun = join(directory, "fake-bun");
  const log = join(directory, "commands.log");
  writeFileSync(
    fakeBun,
    `#!/bin/sh
printf '%s\t%s\n' "$PWD" "$*" >> "$RELEASE_FAKE_LOG"
if [ -n "$RELEASE_FAKE_FAIL" ]; then
  case "$*" in
    *"$RELEASE_FAKE_FAIL"*) exit 17 ;;
  esac
fi
exit 0
`,
  );
  chmodSync(fakeBun, 0o755);
  return {
    repo,
    bare,
    fakeBun,
    log,
    originalPackage: readFileSync(join(repo, "package.json"), "utf8"),
  };
}

function run(f: Fixture, args: string[], failOn = ""): { code: number; output: string } {
  const output: string[] = [];
  const logger = {
    log: (...parts: unknown[]) => output.push(parts.join(" ")),
    error: (...parts: unknown[]) => output.push(parts.join(" ")),
  };
  const code = runRelease({
    cwd: f.repo,
    argv: args,
    bunExecutable: f.fakeBun,
    env: { RELEASE_FAKE_LOG: f.log, RELEASE_FAKE_FAIL: failOn },
    logger,
  });
  return { code: Number(code), output: output.join("\n") };
}

test("help and invalid versions stop before touching Git", async () => {
  const messages: string[] = [];
  expect(
    await runRelease({
      argv: ["--help"],
      logger: { log: (x) => messages.push(String(x)), error: () => {} },
    }),
  ).toBe(0);
  expect(messages.join("\n")).toContain("Usage: bun run release <X.Y.Z>");

  const f = fixture();
  expect(run(f, ["1.2.3-beta"])).toMatchObject({ code: 2 });
  expect(readFileSync(join(f.repo, "package.json"), "utf8")).toBe(f.originalPackage);
  expect(command(f.repo, ["log", "-1", "--format=%s"]).trim()).toBe("Initial fixture");
});

test("requires a clean tracked and untracked tree", () => {
  const f = fixture();
  writeFileSync(join(f.repo, "untracked.txt"), "untracked\n");
  expect(run(f, ["0.3.0"]).code).toBe(1);
  expect(readFileSync(join(f.repo, "package.json"), "utf8")).toBe(f.originalPackage);
  expect(existsSync(f.log)).toBe(false);
});

test("rejects a version whose tag already exists locally or remotely", () => {
  const f = fixture();
  command(f.repo, ["tag", "-a", "v0.2.1", "-m", "Existing tag"]);
  command(f.repo, ["push", "origin", "refs/tags/v0.2.1"]);
  const result = run(f, ["v0.2.1"]);
  expect(result.code).toBe(1);
  expect(result.output).toContain("tag v0.2.1 already exists locally");
  command(f.repo, ["tag", "-d", "v0.2.1"]);
  expect(run(f, ["0.2.1"]).output).toContain("tag v0.2.1 already exists on origin");
  expect(readFileSync(join(f.repo, "package.json"), "utf8")).toBe(f.originalPackage);
});

test("dry-run checks remote state without fetching, building, or mutating", () => {
  const f = fixture();
  const beforeHead = command(f.repo, ["rev-parse", "HEAD"]).trim();
  const beforeStatus = command(f.repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const result = run(f, ["0.3.0", "--dry-run"]);
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain("Dry run passed");
  expect(command(f.repo, ["rev-parse", "HEAD"]).trim()).toBe(beforeHead);
  expect(command(f.repo, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(beforeStatus);
  expect(readFileSync(join(f.repo, "package.json"), "utf8")).toBe(f.originalPackage);
  expect(existsSync(f.log)).toBe(false);
});

test("failed validation restores package.json and creates no release refs", () => {
  const f = fixture();
  const result = run(f, ["0.3.0"], "run check");
  expect(result.code, result.output).toBe(1);
  expect(readFileSync(join(f.repo, "package.json"), "utf8")).toBe(f.originalPackage);
  expect(command(f.repo, ["log", "-1", "--format=%s"]).trim()).toBe("Initial fixture");
  expect(command(f.repo, ["tag", "--list", "v0.3.0"])).toBe("");
  expect(command(f.repo, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");
});

test("successful release commits only package.json and atomically updates origin", () => {
  const f = fixture();
  command(f.repo, ["tag", "-a", "v0.2.1", "-m", "Unpublished old tag"]);
  command(f.repo, ["config", "push.followTags", "true"]);
  const result = run(f, ["v0.3.0"]);
  expect(result.code, result.output).toBe(0);
  expect(JSON.parse(readFileSync(join(f.repo, "package.json"), "utf8")).version).toBe("0.3.0");
  expect(command(f.repo, ["log", "-1", "--format=%s"]).trim()).toBe("Release v0.3.0");
  expect(command(f.repo, ["log", "-1", "--format=%B"])).not.toContain("Co-authored-by:");
  expect(command(f.repo, ["diff", "HEAD^", "HEAD", "--name-only"]).trim()).toBe("package.json");
  expect(command(f.repo, ["cat-file", "-t", "refs/tags/v0.3.0"]).trim()).toBe("tag");
  const head = command(f.repo, ["rev-parse", "HEAD"]).trim();
  expect(command(f.repo, ["--git-dir", f.bare, "rev-parse", "refs/heads/main"]).trim()).toBe(head);
  expect(command(f.repo, ["--git-dir", f.bare, "rev-parse", "refs/tags/v0.3.0^{}"]).trim()).toBe(
    head,
  );
  expect(command(f.repo, ["--git-dir", f.bare, "tag", "--list", "v0.2.1"])).toBe("");
  const log = readFileSync(f.log, "utf8");
  expect(log).toContain(`${f.repo}\tinstall --frozen-lockfile`);
  expect(log).toContain(`${f.repo}\trun check`);
  expect(log).toContain(`${f.repo}\trun build`);
  expect(log).not.toContain("build:all");
  expect(log.indexOf("run build")).toBeLessThan(log.indexOf("run test"));
  expect(log).toContain(`${f.repo}\trun test`);
  expect(log).toContain(`${f.repo}\trun check:release`);
  expect(log).toContain(`${join(f.repo, "site")}\tinstall --frozen-lockfile`);
  expect(log).toContain(`${join(f.repo, "site")}\trun check`);
  expect(log).toContain(`${join(f.repo, "site")}\trun test`);
  expect(log).toContain(`${join(f.repo, "site")}\trun build`);
  expect(result.output).toContain("CI publication is pending");
});

test("failed push keeps the local commit and tag with an exact retry command", () => {
  const f = fixture();
  const hook = join(f.bare, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  const result = run(f, ["0.3.0"]);
  expect(result.code, result.output).toBe(1);
  expect(command(f.repo, ["log", "-1", "--format=%s"]).trim()).toBe("Release v0.3.0");
  expect(command(f.repo, ["cat-file", "-t", "refs/tags/v0.3.0"]).trim()).toBe("tag");
  expect(result.output).toContain("Publication is unconfirmed");
  const releaseCommit = command(f.repo, ["rev-parse", "HEAD"]).trim();
  expect(result.output).toContain(
    `git push --atomic --no-follow-tags origin ${releaseCommit}:refs/heads/main refs/tags/v0.3.0`,
  );
  expect(command(f.repo, ["--git-dir", f.bare, "tag", "--list", "v0.3.0"])).toBe("");
  expect(command(f.repo, ["--git-dir", f.bare, "rev-parse", "refs/heads/main"]).trim()).toBe(
    command(f.repo, ["rev-parse", "HEAD^1"]).trim(),
  );
});

test("dry-run preserves a dirty package and its staged contents", () => {
  const f = fixture();
  const changed = f.originalPackage.replace("fixture", "changed");
  writeFileSync(join(f.repo, "package.json"), changed);
  command(f.repo, ["add", "package.json"]);
  const staged = command(f.repo, ["diff", "--cached"]);
  expect(run(f, ["0.3.0", "--dry-run"]).code).toBe(1);
  expect(command(f.repo, ["diff", "--cached"])).toBe(staged);
  expect(readFileSync(join(f.repo, "package.json"), "utf8")).toBe(changed);
});

test("dry-run uses live remote state without creating missing tracking refs", () => {
  const f = fixture();
  command(f.repo, ["update-ref", "-d", "refs/remotes/origin/main"]);
  const refs = command(f.repo, ["show-ref"]);
  expect(run(f, ["0.3.0", "--dry-run"]).code).toBe(0);
  expect(command(f.repo, ["show-ref"])).toBe(refs);
  expect(existsSync(f.log)).toBe(false);
});

test("refuses an unpushed main branch or a different branch", () => {
  const f = fixture();
  command(f.repo, ["checkout", "-b", "work"]);
  expect(run(f, ["0.3.0"]).output).toContain("main branch");
  command(f.repo, ["checkout", "main"]);
  command(f.repo, ["commit", "--allow-empty", "-m", "Unpushed"]);
  expect(run(f, ["0.3.0"]).output).toContain("commit and push");
  expect(existsSync(f.log)).toBe(false);
});

test("updates the root version even when nested metadata has a version first", () => {
  const f = fixture();
  writeFileSync(
    join(f.repo, "package.json"),
    JSON.stringify({ metadata: { version: "keep" }, name: "fixture", version: "0.2.0" }, null, 2) +
      "\n",
  );
  command(f.repo, ["add", "package.json"]);
  command(f.repo, ["commit", "-m", "Metadata"]);
  command(f.repo, ["push", "origin", "main"]);
  expect(run(f, ["0.3.0"]).code).toBe(0);
  const pkg = JSON.parse(command(f.repo, ["show", "v0.3.0:package.json"]));
  expect(pkg.version).toBe("0.3.0");
  expect(pkg.metadata.version).toBe("keep");
});

test("preserves package edits made during failing validation", () => {
  const f = fixture();
  writeFileSync(f.fakeBun, '#!/bin/sh\nprintf "user changes\\n" > package.json\nexit 1\n');
  const result = run(f, ["0.3.0"]);
  expect(result.code).toBe(1);
  expect(result.output).toContain("preserving those edits");
  expect(readFileSync(join(f.repo, "package.json"), "utf8")).toBe("user changes\n");
  expect(command(f.repo, ["tag", "--list", "v0.3.0"])).toBe("");
});

test("tag signing failure keeps the commit and reports that no tag exists", () => {
  const f = fixture();
  command(f.repo, ["config", "tag.gpgsign", "true"]);
  command(f.repo, ["config", "gpg.format", "openpgp"]);
  command(f.repo, ["config", "gpg.program", "/nonexistent-baton-test-gpg"]);
  const result = run(f, ["0.3.0"]);
  expect(result.code).toBe(1);
  expect(result.output).toContain("tag v0.3.0 was not created");
  expect(command(f.repo, ["log", "-1", "--format=%s"]).trim()).toBe("Release v0.3.0");
  expect(command(f.repo, ["tag", "--list", "v0.3.0"])).toBe("");
  expect(command(f.repo, ["--git-dir", f.bare, "log", "main", "-1", "--format=%s"]).trim()).toBe(
    "Initial fixture",
  );
});

test("the actual command returns a nonzero exit status for invalid input", () => {
  const result = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "../scripts/release.ts"), "bad"],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("stable X.Y.Z");
});
