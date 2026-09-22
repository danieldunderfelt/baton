---
title: "Releasing"
description: "Validate, tag, and publish a new Baton version."
order: 9
---

Run releases from this repository with Bun and Git installed and push access to `origin`. Commit and push the changes you want to release on `main` first. The working tree must be clean.

## Make a release

Choose an unused stable version greater than the version in `package.json`:

```sh
bun run release 0.2.2 --dry-run
bun run release 0.2.2
```

The dry run checks the version, branch, working tree, remote commit, and tag availability. It prints the steps without changing files or Git refs, running builds, or pushing.

The release command:

1. Checks that local `main` matches `origin/main` and that the tag is unused locally and remotely.
2. Updates `package.json` to the requested version.
3. Installs locked dependencies and runs the CLI typecheck, native build, tests, and compiled-binary smoke checks, plus the website checks, tests, and build.
4. Commits the version change and creates an annotated `v<version>` tag.
5. Pushes the release commit and tag together with an atomic Git push.

Use an explicit version such as `0.2.2`; prerelease versions are not supported. You do not need to edit `package.json` or make the tag yourself.

## Check publication

A successful command means the release commit and tag reached GitHub. Publication is complete when the [Release workflow](https://github.com/danieldunderfelt/baton/actions/workflows/release.yml) succeeds.

GitHub Actions builds macOS and Linux binaries for arm64 and x64, tests each binary on its target platform, and publishes all four binaries with `SHA256SUMS` on the [releases page](https://github.com/danieldunderfelt/baton/releases). The workflow rejects tags whose version differs from `package.json`.

With the optional GitHub CLI:

```sh
gh run list --workflow release.yml --branch v0.2.2
gh run watch <run-id> --exit-status
gh release view v0.2.2
```

After publication, verify `baton update` on an installed copy and check `baton --version`. The update refreshes tracked Baton skills automatically and preserves host registrations. Restart agent sessions to load the new server and instructions. Older installations in other projects need one `baton install` to enter the refresh manifest; see [Updating](/docs/installation#updating).

## Recover from a failure

If local validation fails, fix the reported problem, commit and push the fix, and run the release command again. The command restores the previous package version when validation fails before the release commit.

If validation changes `package.json` beyond the version bump, the command preserves those edits for review. If you interrupt the command before it commits, inspect `git diff` and undo the version bump before retrying. A failed release may leave a newly built local binary in `dist/`; rebuild after restoring the version if you plan to use it.

If tag signing fails, the version commit remains local and the command prints the tag and push commands to run after fixing your signing setup. It uses your existing Git commit and tag signing configuration.

If the push fails, the release commit and tag stay local. Use the exact retry command printed by the script after resolving the connection or permission problem. Do not rerun the release command for that version: its tag now exists. An atomic push sends both refs or neither, though a lost connection can make the result unclear. Check the remote refs before retrying:

```sh
git ls-remote origin refs/heads/main refs/tags/v0.2.2
```

If remote `main` advanced, preserve the existing tag and prepare a new release version after incorporating those changes. Do not force-push a release tag.

If GitHub Actions fails because of a temporary runner or service problem, rerun that workflow. If it needs a source-code fix, commit and push the fix and release a new version. Published tags must keep pointing at the original release.

## Tags made by hand

An ordinary `git push` does not push newly created tags. A local tag alone does not start a release, and pushing a tag cannot fix a mismatched package version.

Check a tag before using it:

```sh
git show v0.2.1:package.json
git ls-remote --tags origin refs/tags/v0.2.1
```

If a tag points at the wrong version, choose a new unused version with the release command. It never moves or deletes an existing tag.
