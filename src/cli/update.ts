import { chmodSync, existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import pkg from "../../package.json" with { type: "json" };

/**
 * `baton update`: replace the running binary with the latest release, or, when
 * Baton runs out of a checkout, rebuild it there. One command either way, so
 * keeping up never needs the README.
 *
 * The release path mirrors install.sh: pick the artifact for this OS/arch,
 * verify it against the release's SHA256SUMS, write it beside the current
 * binary, re-sign it on macOS (the kernel SIGKILLs a Mach-O whose ad-hoc
 * signature no longer matches its bytes), and rename it into place. The
 * process that is running keeps its old inode and finishes normally.
 */

export const CURRENT_VERSION: string = pkg.version;
export const RELEASES_URL = "https://github.com/danieldunderfelt/baton/releases";

export interface UpdateResult {
  /** "release" or "checkout": where the new build came from. */
  source: "release" | "checkout";
  from: string;
  to: string;
  /** False when nothing had to change. */
  changed: boolean;
  path: string;
  notes: string[];
}

export interface UpdateOptions {
  /** The binary to replace. Defaults to the running one. */
  execPath?: string;
  /** Release page root; `/latest` redirects to the newest tag. */
  releasesUrl?: string;
  /** For tests: the platform artifact name. */
  target?: string;
}

/** `baton-<os>-<arch>` as the release workflow names it, or null if unsupported. */
export function releaseTarget(platform = process.platform, arch = process.arch): string | null {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  return os && cpu ? `baton-${os}-${cpu}` : null;
}

/**
 * The checkout this binary was built in, if it lives at `<root>/dist/baton`
 * beside the sources. Null for an installed release.
 */
export function checkoutRoot(execPath: string): string | null {
  const root = resolve(dirname(execPath), "..");
  return basename(dirname(execPath)) === "dist" && isCheckout(root) ? root : null;
}

function isCheckout(root: string): boolean {
  return existsSync(join(root, "package.json")) && existsSync(join(root, "src", "index.ts"));
}

/** `bun run src/index.ts`: no binary to replace, the checkout is the thing to rebuild. */
function sourceRoot(): string | null {
  const bundled = import.meta.dir.startsWith("/$bunfs") || import.meta.dir.startsWith("B:\\~BUN");
  const root = resolve(import.meta.dir, "..", "..");
  return !bundled && isCheckout(root) ? root : null;
}

export async function selfUpdate(opts: UpdateOptions = {}): Promise<UpdateResult> {
  const root = opts.execPath ? checkoutRoot(opts.execPath) : (sourceRoot() ?? checkoutRoot(process.execPath));
  if (root) return updateCheckout(root);
  const execPath = opts.execPath ?? process.execPath;
  return updateFromRelease(execPath, opts.releasesUrl ?? RELEASES_URL, opts.target ?? releaseTarget());
}

/** git pull, bun install, bun run build: what a contributor would type. */
function updateCheckout(root: string): UpdateResult {
  const notes: string[] = [];
  const before = CURRENT_VERSION;
  const run = (cmd: string[], failure: string): string => {
    const res = Bun.spawnSync({ cmd, cwd: root, stdout: "pipe", stderr: "pipe" });
    if (res.exitCode !== 0) {
      throw new Error(`${failure}: ${res.stderr.toString().trim() || `exit ${res.exitCode}`}`);
    }
    return res.stdout.toString().trim();
  };
  if (existsSync(join(root, ".git"))) {
    const pulled = run(["git", "pull", "--ff-only"], `git pull failed in ${root}`);
    notes.push(pulled.split("\n").at(-1) ?? "");
  } else {
    notes.push(`${root} is not a git checkout; rebuilt what is there.`);
  }
  run(["bun", "install", "--silent"], "bun install failed");
  run(["bun", "run", "build"], "build failed");
  const binary = join(root, "dist", "baton");
  notes.push(...resign(binary));
  const after = run([binary, "--version"], "the rebuilt binary does not run");
  return { source: "checkout", from: before, to: after, changed: true, path: binary, notes };
}

async function updateFromRelease(
  execPath: string,
  releasesUrl: string,
  target: string | null,
): Promise<UpdateResult> {
  if (!target) {
    throw new Error(
      `No prebuilt Baton for ${process.platform}/${process.arch}. Releases cover macOS and Linux on arm64 and x64.`,
    );
  }
  const tag = await latestTag(releasesUrl);
  const to = tag.replace(/^v/, "");
  const path = execPath;
  if (to === CURRENT_VERSION) {
    return { source: "release", from: CURRENT_VERSION, to, changed: false, path, notes: [] };
  }
  const base = `${releasesUrl}/download/${tag}`;
  const [binary, sums] = await Promise.all([
    download(`${base}/${target}`),
    download(`${base}/SHA256SUMS`).then((b) => new TextDecoder().decode(b)),
  ]);
  const expected = sums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === target)?.[0];
  if (!expected) throw new Error(`Release ${tag} has no checksum for ${target}; not installing it.`);
  const actual = new Bun.CryptoHasher("sha256").update(binary).digest("hex");
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${target} in ${tag}; not installing it.`);
  }

  // Same directory, so the final rename is atomic and cannot cross a filesystem.
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.update`);
  try {
    writeFileSync(tmp, binary, { mode: 0o755 });
    chmodSync(tmp, 0o755);
    const notes = resign(tmp);
    renameSync(tmp, path);
    return { source: "release", from: CURRENT_VERSION, to, changed: true, path, notes };
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing was written.
    }
    throw err;
  }
}

/** `/releases/latest` answers with a redirect to `/releases/tag/<tag>`. */
async function latestTag(releasesUrl: string): Promise<string> {
  const res = await fetch(`${releasesUrl}/latest`, { redirect: "manual" });
  const location = res.headers.get("location");
  const tag = location?.match(/\/tag\/([^/?#]+)/)?.[1];
  if (!tag) {
    throw new Error(
      `Could not find the latest release at ${releasesUrl}/latest (HTTP ${res.status}). Check the network, or pin one with BATON_VERSION and the install script.`,
    );
  }
  return decodeURIComponent(tag);
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${url} (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/** macOS only. Returns a warning if signing was needed and failed. */
function resign(path: string): string[] {
  if (process.platform !== "darwin" || !Bun.which("codesign")) return [];
  const res = Bun.spawnSync({ cmd: ["codesign", "--force", "--sign", "-", path], stdout: "pipe", stderr: "pipe" });
  return res.exitCode === 0
    ? []
    : [`Could not re-sign ${path}; if it exits 137, run: codesign --force --sign - ${path}`];
}
