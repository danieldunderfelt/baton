import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import type { ProfileDocument } from "../eval/profileDocument.ts";
import { validateProfileDocument } from "../eval/profileDocument.ts";

/**
 * Client for the sharing site: sign in with GitHub through a device flow, then
 * publish, fetch, list and revoke shared profiles. A share is a profile
 * document (PLAN.md §Layering and sharing — canonical priors, nothing local)
 * reachable by a short code; the site keeps no directory of them.
 *
 * The token lives in the scope's config dir, so each BATON_CONFIG_DIR world
 * signs in on its own, like everything else Baton knows.
 */

export const DEFAULT_SITE_URL = "https://baton.sh";
export const AUTH_FILE = "auth.json";

/** `BATON_SITE_URL` points the CLI at a self-hosted or local site. */
export function siteUrl(env: Record<string, string | undefined> = Bun.env): string {
  return (env.BATON_SITE_URL ?? DEFAULT_SITE_URL).replace(/\/+$/, "");
}

export interface AuthFile {
  site: string;
  token: string;
  login: string;
  created_at: string;
}

export function readAuth(configDir: string, site: string): AuthFile | null {
  const path = join(configDir, AUTH_FILE);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AuthFile>;
  if (typeof parsed.token !== "string" || typeof parsed.login !== "string") return null;
  // A token minted by one site is meaningless at another (local dev vs. prod).
  if (parsed.site !== site) return null;
  return parsed as AuthFile;
}

export function writeAuth(configDir: string, auth: AuthFile): string {
  const path = join(configDir, AUTH_FILE);
  writeFileSync(path, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function clearAuth(configDir: string): boolean {
  const path = join(configDir, AUTH_FILE);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export class SiteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

/** True when the site said the token is no longer good: sign in again. */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof SiteError && err.status === 401;
}

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface LoginOptions {
  /** Shown on the approval page and in the account's token list. */
  label?: string;
  print?: (line: string) => void;
  /** Injected clock for tests; the flow otherwise sleeps `interval` seconds per poll. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The device flow: ask the site for a code, show it, poll until the browser
 * side approves. No local callback server, so it works over SSH just as well.
 */
export async function deviceLogin(site: string, opts: LoginOptions = {}): Promise<AuthFile> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const start = await call<DeviceStart>(site, "POST", "/api/device/code", {
    body: { label: opts.label ?? hostname() },
  });
  print(`Open ${start.verification_uri_complete}`);
  print(`and confirm the code ${start.user_code} to sign in with GitHub.`);
  openBrowser(start.verification_uri_complete);

  const deadline = Date.now() + start.expires_in * 1000;
  let interval = Math.max(0, start.interval) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    try {
      const res = await call<{ token: string; login: string }>(site, "POST", "/api/device/token", {
        body: { device_code: start.device_code },
      });
      return { site, token: res.token, login: res.login, created_at: new Date().toISOString() };
    } catch (err) {
      if (!(err instanceof SiteError)) throw err;
      if (err.code === "authorization_pending") continue;
      if (err.code === "slow_down") {
        interval += 5000;
        continue;
      }
      throw err;
    }
  }
  throw new Error("Sign-in timed out: the code was not confirmed in time. Run 'baton login' again.");
}

/** Best effort: a terminal over SSH has no browser, and the URL is printed anyway. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? ["open", url] : process.platform === "linux" ? ["xdg-open", url] : null;
  if (!cmd || Bun.env.BATON_NO_BROWSER) return;
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).unref();
  } catch {
    // Nothing to do: the user has the URL.
  }
}

export interface ShareSummary {
  code: string;
  url: string;
  name: string;
  entry_count: number;
  created_at: string;
  updated_at: string;
}

export interface ShareResult extends ShareSummary {
  /** False when an existing share of the same profile name was updated in place. */
  created: boolean;
}

export interface SharedProfile {
  code: string;
  url: string;
  owner: { login: string; avatar_url: string | null };
  created_at: string;
  updated_at: string;
  profile: ProfileDocument;
}

export function shareProfile(site: string, token: string, doc: ProfileDocument): Promise<ShareResult> {
  return call<ShareResult>(site, "POST", "/api/profiles", { token, body: doc });
}

export async function fetchShare(site: string, code: string): Promise<SharedProfile> {
  const res = await call<SharedProfile>(site, "GET", `/api/profiles/${encodeURIComponent(code)}`);
  // The site validated on upload, but the document is about to become priors
  // here: the same guarantee has to hold at this end too.
  return { ...res, profile: validateProfileDocument(res.profile, `share ${code}`) };
}

export async function listShares(site: string, token: string): Promise<ShareSummary[]> {
  const res = await call<{ shares: ShareSummary[] }>(site, "GET", "/api/profiles", { token });
  return res.shares;
}

export function revokeShare(site: string, token: string, code: string): Promise<void> {
  return call<void>(site, "DELETE", `/api/profiles/${encodeURIComponent(code)}`, { token });
}

export function revokeToken(site: string, token: string): Promise<void> {
  return call<void>(site, "POST", "/api/auth/revoke", { token });
}

const SHARE_CODE = /^[a-z0-9]{5}-[a-z0-9]{5}$/;

/**
 * A share reference as the user typed it: the bare code, the code without its
 * dash, or the share link. Null for anything else (a file path, say). Any host
 * is accepted for links: a link is where the profile lives, and BATON_SITE_URL
 * only says where *this* CLI publishes.
 */
export function parseShareRef(arg: string): { code: string; site: string | null } | null {
  const trimmed = arg.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    const match = /^\/p\/([^/]+)\/?$/.exec(url.pathname);
    if (!match) return null;
    const code = normalizeShareCode(decodeURIComponent(match[1]!));
    return code ? { code, site: url.origin } : null;
  }
  const code = normalizeShareCode(trimmed);
  return code ? { code, site: null } : null;
}

export function normalizeShareCode(text: string): string | null {
  const compact = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (compact.length !== 10) return null;
  const code = `${compact.slice(0, 5)}-${compact.slice(5)}`;
  return SHARE_CODE.test(code) ? code : null;
}

interface CallOptions {
  token?: string;
  body?: unknown;
}

async function call<T>(site: string, method: string, path: string, opts: CallOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${site}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (err) {
    throw new Error(`Cannot reach ${site}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body: reported below with the status.
  }
  if (!res.ok) {
    const body = (parsed ?? {}) as { error?: string; message?: string };
    const code = body.error ?? `http_${res.status}`;
    const message =
      body.message ??
      (res.status === 401
        ? "Not signed in, or the token was revoked. Run 'baton login'."
        : `${site}${path} answered ${res.status}.`);
    throw new SiteError(message, res.status, code);
  }
  return parsed as T;
}
