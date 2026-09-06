import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ProfileDocument } from "../eval/profileDocument.ts";
import {
  SiteError,
  deviceLogin,
  fetchShare,
  parseShareRef,
  readAuth,
  shareProfile,
  writeAuth,
} from "./share.ts";

/**
 * The sharing client against a fake site: the same endpoints and error codes
 * the real one serves, in memory. Nothing here reaches the network, and the
 * CLI runs as a subprocess in a throwaway scope like cli.test.ts does.
 */

const ENTRY = resolve(import.meta.dir, "..", "index.ts");
const TOKEN = "bt_test_token";
const OTHER_TOKEN = "bt_other";

interface FakeShare {
  code: string;
  name: string;
  document: ProfileDocument;
  owner: string;
}

class FakeSite {
  server!: ReturnType<typeof Bun.serve>;
  shares = new Map<string, FakeShare>();
  /** device_code → approved? */
  devices = new Map<string, boolean>();
  tokens = new Map<string, string>([
    [TOKEN, "daniel"],
    [OTHER_TOKEN, "someone"],
  ]);
  pollsBeforeApproval = 2;
  nextCode = 0;

  get url(): string {
    return `http://localhost:${this.server.port}`;
  }

  start(): void {
    this.server = Bun.serve({ port: 0, fetch: (req) => this.handle(req) });
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const json = (data: unknown, status = 200) => Response.json(data, { status });
    const err = (status: number, error: string, message: string) => json({ error, message }, status);
    const login = this.tokens.get((req.headers.get("authorization") ?? "").replace(/^Bearer /, ""));

    if (path === "/api/device/code" && req.method === "POST") {
      const device = `dev_${this.devices.size + 1}`;
      this.devices.set(device, false);
      return json({
        device_code: device,
        user_code: "ABCD-EFGH",
        verification_uri: `${this.url}/device`,
        verification_uri_complete: `${this.url}/device?code=ABCD-EFGH`,
        expires_in: 900,
        interval: 0,
      });
    }
    if (path === "/api/device/token" && req.method === "POST") {
      const body = (await req.json()) as { device_code: string };
      if (!this.devices.has(body.device_code)) return err(400, "invalid_grant", "Unknown device code.");
      if (this.pollsBeforeApproval-- > 0) return err(400, "authorization_pending", "Waiting.");
      this.devices.delete(body.device_code);
      return json({ token: TOKEN, login: "daniel" });
    }
    if (path === "/api/auth/revoke" && req.method === "POST") {
      if (!login) return err(401, "unauthorized", "Not signed in.");
      return new Response(null, { status: 204 });
    }
    if (path === "/api/profiles" && req.method === "POST") {
      if (!login) return err(401, "unauthorized", "Not signed in, or the token was revoked. Run 'baton login'.");
      const doc = (await req.json()) as ProfileDocument;
      const existing = [...this.shares.values()].find((s) => s.owner === login && s.name === doc.name);
      const code = existing?.code ?? `abcde-fgh${String(++this.nextCode).padStart(2, "j")}`;
      this.shares.set(code, { code, name: doc.name, document: doc, owner: login });
      return json({
        code,
        url: `${this.url}/p/${code}`,
        name: doc.name,
        entry_count: doc.entries.length,
        created_at: "2026-01-02T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
        created: !existing,
      });
    }
    if (path === "/api/profiles" && req.method === "GET") {
      if (!login) return err(401, "unauthorized", "Not signed in.");
      const shares = [...this.shares.values()]
        .filter((s) => s.owner === login)
        .map((s) => ({
          code: s.code,
          url: `${this.url}/p/${s.code}`,
          name: s.name,
          entry_count: s.document.entries.length,
          created_at: "2026-01-02T00:00:00.000Z",
          updated_at: "2026-01-03T00:00:00.000Z",
        }));
      return json({ shares });
    }
    const one = /^\/api\/profiles\/([^/]+)$/.exec(path);
    if (one) {
      const share = this.shares.get(one[1]!);
      if (req.method === "GET") {
        if (!share) return err(404, "not_found", "No shared profile with that code.");
        return json({
          code: share.code,
          url: `${this.url}/p/${share.code}`,
          owner: { login: share.owner, avatar_url: null },
          created_at: "2026-01-02T00:00:00.000Z",
          updated_at: "2026-01-03T00:00:00.000Z",
          profile: share.document,
        });
      }
      if (req.method === "DELETE") {
        if (!login) return err(401, "unauthorized", "Not signed in.");
        if (!share || share.owner !== login) return err(404, "not_found", "Not among yours.");
        this.shares.delete(share.code);
        return new Response(null, { status: 204 });
      }
    }
    return err(404, "not_found", `No route ${req.method} ${path}`);
  }
}

const site = new FakeSite();
beforeAll(() => site.start());
afterAll(() => site.server.stop(true));

const DOC: ProfileDocument = {
  name: "mine",
  exported_at: "2026-01-01T00:00:00.000Z",
  entries: [
    { model: "opus-5", category: "", mean: 4, weight: 5, as_of: "2026-01-01T00:00:00.000Z" },
    { model: "kimi-k3", category: "implementation", mean: 4.5, weight: 3, as_of: "2026-01-01T00:00:00.000Z" },
  ],
};

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `baton-share-${prefix}-`));
}

async function baton(scope: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "run", ENTRY, ...args], {
    env: { ...process.env, BATON_HOPS: undefined, BATON_CONFIG_DIR: scope, BATON_SITE_URL: site.url, BATON_NO_BROWSER: "1" },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("parseShareRef", () => {
  test("accepts a code, a code without its dash, and a share link on any host", () => {
    expect(parseShareRef("k7mq3-v2xrd")).toEqual({ code: "k7mq3-v2xrd", site: null });
    expect(parseShareRef("K7MQ3V2XRD")).toEqual({ code: "k7mq3-v2xrd", site: null });
    expect(parseShareRef("https://baton.sh/p/k7mq3-v2xrd")).toEqual({
      code: "k7mq3-v2xrd",
      site: "https://baton.sh",
    });
    expect(parseShareRef("http://localhost:4321/p/k7mq3-v2xrd/")).toEqual({
      code: "k7mq3-v2xrd",
      site: "http://localhost:4321",
    });
  });

  test("rejects file paths and links that are not share links", () => {
    expect(parseShareRef("./profile.yaml")).toBeNull();
    expect(parseShareRef("profile.yaml")).toBeNull();
    expect(parseShareRef("https://baton.sh/docs/sharing")).toBeNull();
    expect(parseShareRef("https://baton.sh/p/../account")).toBeNull();
  });
});

describe("device login", () => {
  test("polls through authorization_pending and stores the token owner-only", async () => {
    const lines: string[] = [];
    process.env.BATON_NO_BROWSER = "1";
    const auth = await deviceLogin(site.url, {
      label: "test-host",
      print: (l) => lines.push(l),
      sleep: async () => {},
    });
    expect(auth.token).toBe(TOKEN);
    expect(auth.login).toBe("daniel");
    expect(auth.site).toBe(site.url);
    expect(lines[0]).toContain("/device?code=ABCD-EFGH");
    expect(lines[1]).toContain("ABCD-EFGH");

    const dir = tmp("auth");
    const path = writeAuth(dir, auth);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readAuth(dir, site.url)?.login).toBe("daniel");
    // A token from another site is not this site's token.
    expect(readAuth(dir, "https://elsewhere.example")).toBeNull();
  });
});

describe("share client", () => {
  test("shares, fetches, and reports a revoked token as unauthorized", async () => {
    const shared = await shareProfile(site.url, TOKEN, DOC);
    expect(shared.created).toBe(true);
    expect(shared.url).toBe(`${site.url}/p/${shared.code}`);

    const fetched = await fetchShare(site.url, shared.code);
    expect(fetched.owner.login).toBe("daniel");
    expect(fetched.profile).toEqual(DOC);

    const again = await shareProfile(site.url, TOKEN, DOC);
    expect(again.created).toBe(false);
    expect(again.code).toBe(shared.code);

    await expect(shareProfile(site.url, "bt_revoked", DOC)).rejects.toMatchObject({ status: 401 });
    await expect(fetchShare(site.url, "zzzzz-zzzzz")).rejects.toBeInstanceOf(SiteError);
  });

  test("refuses a shared document that fails the profile format", async () => {
    site.shares.set("bad00-bad00", {
      code: "bad00-bad00",
      name: "bad",
      owner: "someone",
      document: { name: "bad", entries: [{ model: "kimi:work/k3", mean: 4 }] } as never,
    });
    await expect(fetchShare(site.url, "bad00-bad00")).rejects.toThrow(/not a canonical model id/);
  });
});

describe("CLI", () => {
  test("profile import <code> previews, then commits under login/name", async () => {
    const scope = tmp("import");
    const shared = await shareProfile(site.url, OTHER_TOKEN, { ...DOC, name: "picks" });

    const preview = await baton(scope, "profile", "import", shared.code);
    expect(preview.code).toBe(0);
    expect(preview.stdout).toContain("shared by @someone");
    expect(preview.stdout).toContain("Profile 'someone/picks' → local profile 'someone/picks'");
    expect(preview.stdout).toContain("+ kimi-k3 [implementation]");
    expect(preview.stdout).toContain("Nothing was written");

    const commit = await baton(scope, "profile", "import", `${site.url}/p/${shared.code}`, "--yes", "--activate");
    expect(commit.code).toBe(0);
    expect(commit.stdout).toContain("Active profile is now 'someone/picks'");

    const ratings = await baton(scope, "ratings");
    expect(ratings.stdout).toContain("someone/picks");
  });

  test("profile import of an unknown code or a non-file fails clearly", async () => {
    const scope = tmp("import-bad");
    const missing = await baton(scope, "profile", "import", "zzzzz-zzzzz");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("No shared profile with that code");

    const junk = await baton(scope, "profile", "import", "not-a-file-or-code");
    expect(junk.code).toBe(1);
    expect(junk.stderr).toContain("neither a profile file nor a share code");
  });

  test("profile share, shares, unshare and logout with a stored token", async () => {
    const scope = tmp("share");
    const file = join(scope, "p.json");
    writeFileSync(file, JSON.stringify({ ...DOC, name: "cli-shared" }));
    expect((await baton(scope, "profile", "import", file, "--yes")).code).toBe(0);
    writeAuth(scope, { site: site.url, token: TOKEN, login: "daniel", created_at: "2026-01-01T00:00:00.000Z" });

    const share = await baton(scope, "profile", "share", "--profile", "cli-shared");
    expect(share.code).toBe(0);
    expect(share.stdout).toContain("Shared profile 'cli-shared' (2 priors) as @daniel.");
    expect(share.stdout).toContain("category names are free text");
    const code = /Import: baton profile import (\S+)/.exec(share.stdout)?.[1];
    expect(code).toBeTruthy();
    expect(share.stdout).toContain(`Link:   ${site.url}/p/${code}`);

    const again = await baton(scope, "profile", "share", "--profile", "cli-shared");
    expect(again.stdout).toContain("Updated profile 'cli-shared'");

    const list = await baton(scope, "profile", "shares");
    expect(list.stdout).toContain("cli-shared");
    expect(list.stdout).toContain(code!);

    const gone = await baton(scope, "profile", "unshare", code!);
    expect(gone.code).toBe(0);
    expect(gone.stdout).toContain(`Revoked share ${code}`);
    expect(site.shares.has(code!)).toBe(false);

    const out = await baton(scope, "logout");
    expect(out.stdout).toContain("Signed out");
    expect(readAuth(scope, site.url)).toBeNull();
    expect((await baton(scope, "profile", "shares")).stderr).toContain("Not signed in");
  });

  test("a token the site no longer accepts is discarded", async () => {
    const scope = tmp("dead-token");
    writeAuth(scope, { site: site.url, token: "bt_dead", login: "daniel", created_at: "2026-01-01T00:00:00.000Z" });
    const res = await baton(scope, "profile", "shares");
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("baton login");
    expect(readAuth(scope, site.url)).toBeNull();
  });

  test("login through the device flow stores the token in the scope", async () => {
    const scope = tmp("login");
    site.pollsBeforeApproval = 1;
    const res = await baton(scope, "login");
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("confirm the code ABCD-EFGH");
    expect(res.stdout).toContain("Signed in as @daniel");
    const stored = JSON.parse(readFileSync(join(scope, "auth.json"), "utf8")) as { token: string };
    expect(stored.token).toBe(TOKEN);
    expect((await baton(scope, "login")).stdout).toContain("Already signed in");
  });
});
