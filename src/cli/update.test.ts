import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CURRENT_VERSION, checkoutRoot, releaseTarget, selfUpdate } from "./update.ts";

/**
 * A stand-in for the GitHub releases site: `/latest` redirects to the newest
 * tag, and `/download/<tag>/<file>` serves the artifacts. What the real thing
 * does, minus the network.
 */
function fakeReleases(tag: string, files: Record<string, string>): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/latest")) {
        return new Response(null, { status: 302, headers: { location: `/releases/tag/${tag}` } });
      }
      const name = path.split(`/download/${tag}/`)[1];
      const body = name === undefined ? undefined : files[name];
      return body === undefined ? new Response("no", { status: 404 }) : new Response(body);
    },
  });
  return { url: `http://127.0.0.1:${server.port}/releases`, stop: () => server.stop(true) };
}

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

const TARGET = "baton-test-x64";

describe("releaseTarget", () => {
  test("names the artifact the release workflow publishes, or nothing", () => {
    expect(releaseTarget("darwin", "arm64")).toBe("baton-darwin-arm64");
    expect(releaseTarget("linux", "x64")).toBe("baton-linux-x64");
    expect(releaseTarget("win32", "x64")).toBeNull();
  });
});

describe("checkoutRoot", () => {
  test("recognises <root>/dist/baton beside the sources, and nothing else", () => {
    const root = mkdtempSync(join(tmpdir(), "baton-checkout-"));
    mkdirSync(join(root, "dist"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "src", "index.ts"), "");
    expect(checkoutRoot(join(root, "dist", "baton"))).toBe(root);
    expect(checkoutRoot(join(root, "baton"))).toBeNull();
    expect(checkoutRoot("/usr/local/bin/baton")).toBeNull();
  });
});

describe("selfUpdate from a release", () => {
  test("replaces the binary with the verified artifact of a newer tag", async () => {
    const binary = "#!/bin/sh\necho new\n";
    const releases = fakeReleases("v99.0.0", {
      [TARGET]: binary,
      SHA256SUMS: `${sha256(binary)}  ${TARGET}\n`,
    });
    const dir = mkdtempSync(join(tmpdir(), "baton-update-"));
    const execPath = join(dir, "baton");
    writeFileSync(execPath, "#!/bin/sh\necho old\n", { mode: 0o755 });
    try {
      const res = await selfUpdate({ execPath, releasesUrl: releases.url, target: TARGET });
      expect(res).toMatchObject({ source: "release", from: CURRENT_VERSION, to: "99.0.0", changed: true });
      expect(readFileSync(execPath, "utf8")).toBe(binary);
    } finally {
      releases.stop();
    }
  });

  test("a bad checksum leaves the binary alone", async () => {
    const releases = fakeReleases("v99.0.0", {
      [TARGET]: "tampered",
      SHA256SUMS: `${sha256("original")}  ${TARGET}\n`,
    });
    const dir = mkdtempSync(join(tmpdir(), "baton-update-bad-"));
    const execPath = join(dir, "baton");
    writeFileSync(execPath, "old", { mode: 0o755 });
    try {
      await expect(
        selfUpdate({ execPath, releasesUrl: releases.url, target: TARGET }),
      ).rejects.toThrow(/Checksum mismatch/);
      expect(readFileSync(execPath, "utf8")).toBe("old");
    } finally {
      releases.stop();
    }
  });

  test("the current version is reported as up to date without downloading", async () => {
    const releases = fakeReleases(`v${CURRENT_VERSION}`, {});
    const execPath = join(mkdtempSync(join(tmpdir(), "baton-update-same-")), "baton");
    writeFileSync(execPath, "old");
    try {
      const res = await selfUpdate({ execPath, releasesUrl: releases.url, target: TARGET });
      expect(res.changed).toBe(false);
      expect(res.to).toBe(CURRENT_VERSION);
    } finally {
      releases.stop();
    }
  });
});
