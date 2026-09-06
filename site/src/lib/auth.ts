import type { AstroCookies } from "astro";

import { ApiError, bearerToken } from "./api.ts";
import { randomSecret } from "./crypto.ts";
import { createSession, deleteSession, userBySession, userByToken, type User } from "./db.ts";
import type { AppEnv } from "./env.ts";

/**
 * Two ways in: a browser session cookie (set after GitHub OAuth) and a CLI
 * bearer token (minted by the device flow). Both resolve to the same User.
 */

export const SESSION_COOKIE = "baton_session";
const STATE_COOKIE = "baton_oauth";

const cookieBase = (request: Request) => ({
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  secure: new URL(request.url).protocol === "https:",
});

export async function currentUser(env: AppEnv, cookies: AstroCookies): Promise<User | null> {
  const raw = cookies.get(SESSION_COOKIE)?.value;
  return raw ? await userBySession(env.DB, raw) : null;
}

export async function signIn(env: AppEnv, request: Request, cookies: AstroCookies, user: User): Promise<void> {
  const raw = await createSession(env.DB, user.id);
  cookies.set(SESSION_COOKIE, raw, { ...cookieBase(request), maxAge: 30 * 24 * 60 * 60 });
}

export async function signOut(env: AppEnv, cookies: AstroCookies): Promise<void> {
  const raw = cookies.get(SESSION_COOKIE)?.value;
  if (raw) await deleteSession(env.DB, raw);
  cookies.delete(SESSION_COOKIE, { path: "/" });
}

/** The user behind an `Authorization: Bearer` token, or a 401. */
export async function requireTokenUser(env: AppEnv, request: Request): Promise<{ user: User; token: string }> {
  const token = bearerToken(request);
  const user = token ? await userByToken(env.DB, token) : null;
  if (!user || !token) {
    throw new ApiError(401, "unauthorized", "Not signed in, or the token was revoked. Run 'baton login'.");
  }
  return { user, token };
}

/**
 * Form posts from our own pages must come from our own origin. Session
 * cookies are SameSite=Lax, which already blocks cross-site POSTs in current
 * browsers; this is the belt to that suspender.
 */
export function isSameOrigin(request: Request): boolean {
  return request.headers.get("origin") === new URL(request.url).origin;
}

export function assertSameOrigin(request: Request): void {
  if (!isSameOrigin(request)) throw new ApiError(403, "forbidden", "Cross-site request refused.");
}

export const crossSite = () => new Response("Cross-site request refused.", { status: 403 });

// --- GitHub OAuth ----------------------------------------------------------

/** Only same-site paths may be a post-login destination. */
export function safeNext(next: string | null | undefined): string {
  // One leading slash, then not another slash or backslash: `//host` and
  // `/\host` are both scheme-relative to a browser.
  return next && /^\/(?![/\\])/.test(next) ? next : "/account";
}

export function beginGithubLogin(
  env: AppEnv,
  request: Request,
  cookies: AstroCookies,
  origin: string,
  next: string,
): Response {
  const state = randomSecret(128);
  cookies.set(STATE_COOKIE, JSON.stringify({ state, next }), { ...cookieBase(request), maxAge: 600 });
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", `${origin}/api/auth/github/callback`);
  url.searchParams.set("state", state);
  // No scopes: the public profile (id, login, avatar) is all attribution needs.
  return Response.redirect(url.toString(), 302);
}

export interface GithubIdentity {
  id: number;
  login: string;
  avatar_url: string | null;
}

/** Validates the state cookie and exchanges the code for the GitHub identity. */
export async function finishGithubLogin(
  env: AppEnv,
  request: Request,
  cookies: AstroCookies,
  origin: string,
): Promise<{ identity: GithubIdentity; next: string }> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const stored = cookies.get(STATE_COOKIE)?.json() as { state?: string; next?: string } | undefined;
  cookies.delete(STATE_COOKIE, { path: "/" });
  if (!code || !state || !stored?.state || stored.state !== state) {
    throw new ApiError(400, "bad_state", "The sign-in link is stale. Start again.");
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${origin}/api/auth/github/callback`,
    }),
  });
  const tokenBody = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenRes.ok || !tokenBody.access_token) {
    throw new ApiError(502, "github", `GitHub did not issue a token (${tokenBody.error ?? tokenRes.status}).`);
  }

  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${tokenBody.access_token}`,
      "user-agent": "baton-site",
    },
  });
  if (!userRes.ok) throw new ApiError(502, "github", `GitHub did not return the user (${userRes.status}).`);
  const profile = (await userRes.json()) as { id: number; login: string; avatar_url?: string };
  return {
    identity: { id: profile.id, login: profile.login, avatar_url: profile.avatar_url ?? null },
    next: safeNext(stored.next),
  };
}
