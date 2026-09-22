import { isoAfter, nowIso, randomSecret, sha256Hex } from "./crypto.ts";
import { newShareCode, newUserCode, normalizeShareCode } from "./codes.ts";
import type { ProfileDocument } from "../../../src/eval/profileDocument.ts";

/**
 * Everything the site stores, in one place. Secrets (session ids, CLI tokens,
 * device codes) are hashed before they reach a row; the raw value exists only
 * in the cookie, the CLI's auth file, or the in-flight device flow.
 */

export interface User {
  id: string;
  github_id: number;
  login: string;
  avatar_url: string | null;
  created_at: string;
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEVICE_TTL_MS = 15 * 60 * 1000;
export const DEVICE_POLL_SECONDS = 5;
// A shared network can start several CLIs without occupying the global pool.
export const MAX_PENDING_DEVICES = 500;
export const MAX_CLIENT_PENDING_DEVICES = 5;
export const MAX_CLIENT_DEVICE_STARTS = 10;
export const DEVICE_RATE_WINDOW_MS = 15 * 60 * 1000;

// Stored JSON bytes, across every profile belonging to one account.
export const MAX_ACCOUNT_PROFILES = 100;
export const MAX_ACCOUNT_PROFILE_BYTES = 5 * 1024 * 1024;
export const PROFILE_PAGE_SIZE = 25;
export const MAX_PROFILE_PAGE_SIZE = 100;

export async function upsertUser(
  db: D1Database,
  github: { id: number; login: string; avatar_url: string | null },
): Promise<User> {
  const user = await db
    .prepare(`INSERT INTO users (id, github_id, login, avatar_url, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (github_id) DO UPDATE SET login = excluded.login, avatar_url = excluded.avatar_url
      RETURNING *`)
    .bind(`u_${randomSecret(96)}`, github.id, github.login, github.avatar_url, nowIso())
    .first<User>();
  if (!user) throw new Error("User upsert returned no row.");
  return user;
}

// --- Browser sessions ------------------------------------------------------

export async function createSession(db: D1Database, userId: string): Promise<string> {
  const raw = randomSecret();
  await db
    .prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(raw), userId, nowIso(), isoAfter(SESSION_TTL_MS))
    .run();
  return raw;
}

export async function userBySession(db: D1Database, raw: string): Promise<User | null> {
  return await db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id_hash = ? AND s.expires_at > ?`,
    )
    .bind(await sha256Hex(raw), nowIso())
    .first<User>();
}

export async function deleteSession(db: D1Database, raw: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256Hex(raw)).run();
}

// --- CLI tokens and the device flow ---------------------------------------

export async function userByToken(db: D1Database, raw: string): Promise<User | null> {
  const hash = await sha256Hex(raw);
  const user = await db
    .prepare("SELECT u.* FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?")
    .bind(hash)
    .first<User>();
  if (user) {
    await db.prepare("UPDATE tokens SET last_used_at = ? WHERE token_hash = ?").bind(nowIso(), hash).run();
  }
  return user;
}

export async function deleteToken(db: D1Database, raw: string): Promise<void> {
  await db.prepare("DELETE FROM tokens WHERE token_hash = ?").bind(await sha256Hex(raw)).run();
}

export interface DeviceStart {
  device_code: string;
  user_code: string;
  expires_in: number;
  interval: number;
}

export class DeviceLimitError extends Error {
  readonly retryAfterSeconds = DEVICE_RATE_WINDOW_MS / 1000;

  constructor() {
    super("Too many sign-in requests. Finish a pending sign-in or try again in 15 minutes.");
  }
}

export async function createDeviceCode(db: D1Database, label: string, clientAddress: string): Promise<DeviceStart> {
  const deviceCode = randomSecret();
  const deviceHash = await sha256Hex(deviceCode);
  const clientHash = await sha256Hex(clientAddress);
  const userCode = newUserCode();
  const now = Date.now();
  const startedAt = new Date(now).toISOString();
  const windowStart = new Date(now - DEVICE_RATE_WINDOW_MS).toISOString();
  // D1 batches are transactions. Checking capacity inside the INSERT prevents
  // concurrent callers from claiming the same last slot; history commits with it.
  const [inserted] = await db.batch([
    db.prepare(`INSERT INTO device_codes
      (device_code_hash, user_code, label, client_hash, created_at, expires_at)
      SELECT ?, ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM device_codes WHERE expires_at > ?) < ?
        AND (SELECT COUNT(*) FROM device_codes WHERE client_hash = ? AND expires_at > ?) < ?
        AND (SELECT COUNT(*) FROM device_starts WHERE client_hash = ? AND created_at > ?) < ?`)
      .bind(deviceHash, userCode, label, clientHash, startedAt, isoAfter(DEVICE_TTL_MS, now),
        startedAt, MAX_PENDING_DEVICES, clientHash, startedAt, MAX_CLIENT_PENDING_DEVICES,
        clientHash, windowStart, MAX_CLIENT_DEVICE_STARTS),
    db.prepare(`INSERT INTO device_starts (device_code_hash, client_hash, created_at)
      SELECT device_code_hash, client_hash, created_at FROM device_codes WHERE device_code_hash = ?`)
      .bind(deviceHash),
  ]);
  if (!inserted?.meta.changes) throw new DeviceLimitError();
  return {
    device_code: deviceCode,
    user_code: userCode,
    expires_in: DEVICE_TTL_MS / 1000,
    interval: DEVICE_POLL_SECONDS,
  };
}

export interface PendingDevice {
  user_code: string;
  label: string;
  user_id: string | null;
  expires_at: string;
}

/** A live, still-unapproved device request for the browser side to confirm. */
export async function pendingDevice(db: D1Database, userCode: string): Promise<PendingDevice | null> {
  return await db
    .prepare(
      `SELECT user_code, label, user_id, expires_at FROM device_codes
       WHERE user_code = ? AND user_id IS NULL AND expires_at > ?`,
    )
    .bind(userCode, nowIso())
    .first<PendingDevice>();
}

export async function approveDevice(db: D1Database, userCode: string, userId: string): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE device_codes SET user_id = ? WHERE user_code = ? AND user_id IS NULL AND expires_at > ?`,
    )
    .bind(userId, userCode, nowIso())
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export type DeviceRedeem =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "invalid" }
  | { status: "ok"; token: string; login: string };

/**
 * The CLI's poll: once approved, mint the token and burn the device code.
 * Claiming is the DELETE itself, so two concurrent polls cannot both mint.
 */
export async function redeemDevice(db: D1Database, rawDeviceCode: string): Promise<DeviceRedeem> {
  const hash = await sha256Hex(rawDeviceCode);
  const now = nowIso();
  const token = `bt_${randomSecret()}`;
  const tokenHash = await sha256Hex(token);
  // Token creation and code consumption commit together. A failed insert
  // keeps the code usable; concurrent polls cannot mint twice.
  const [inserted] = await db.batch<{ user_id: string }>([
    db.prepare(`INSERT INTO tokens (token_hash, user_id, label, created_at)
      SELECT ?, user_id, label, ? FROM device_codes
      WHERE device_code_hash = ? AND user_id IS NOT NULL AND expires_at > ?
      RETURNING user_id`).bind(tokenHash, now, hash, now),
    db.prepare(`DELETE FROM device_codes
      WHERE device_code_hash = ? AND user_id IS NOT NULL AND expires_at > ?`).bind(hash, now),
  ]);
  const claimed = inserted?.results[0];
  if (!claimed) {
    const row = await db
      .prepare("SELECT expires_at FROM device_codes WHERE device_code_hash = ?")
      .bind(hash)
      .first<{ expires_at: string }>();
    if (!row) return { status: "invalid" };
    if (row.expires_at <= now) {
      await db.prepare("DELETE FROM device_codes WHERE device_code_hash = ?").bind(hash).run();
      return { status: "expired" };
    }
    return { status: "pending" };
  }
  const user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(claimed.user_id).first<User>();
  if (!user) return { status: "invalid" };
  return { status: "ok", token, login: user.login };
}

/** Housekeeping on a path that is rare anyway (each `baton login`). */
export async function purgeExpired(db: D1Database): Promise<void> {
  const now = nowIso();
  await db.batch([
    db.prepare("DELETE FROM device_codes WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM device_starts WHERE created_at <= ?")
      .bind(new Date(Date.now() - DEVICE_RATE_WINDOW_MS).toISOString()),
  ]);
}

// --- Shared profiles -------------------------------------------------------

export interface ProfileRow {
  code: string;
  user_id: string;
  name: string;
  document: string;
  entry_count: number;
  created_at: string;
  updated_at: string;
}

export interface ShareSummary {
  code: string;
  name: string;
  entry_count: number;
  created_at: string;
  updated_at: string;
}

export class ProfileLimitError extends Error {
  constructor() {
    super("An account can share up to 100 profiles and 5 MiB of profile data. Revoke an unused share or reduce a profile before sharing again.");
  }
}

/**
 * One live share per (user, profile name): sharing again replaces the
 * document under the same code, so a link already handed out stays current.
 */
export async function upsertProfile(
  db: D1Database,
  userId: string,
  doc: ProfileDocument,
): Promise<ShareSummary & { created: boolean }> {
  const now = nowIso();
  const document = JSON.stringify(doc);
  const documentBytes = new TextEncoder().encode(document).byteLength;
  const code = newShareCode();
  const row = await db
    .prepare(
      `INSERT INTO profiles (code, user_id, name, document, entry_count, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE (EXISTS (SELECT 1 FROM profiles WHERE user_id = ? AND name = ?)
         OR (SELECT COUNT(*) FROM profiles WHERE user_id = ?) < ?)
         AND COALESCE((SELECT SUM(document_bytes) FROM profiles WHERE user_id = ? AND name <> ?), 0) + ? <= ?
       ON CONFLICT (user_id, name) DO UPDATE SET
         document = excluded.document, entry_count = excluded.entry_count, updated_at = excluded.updated_at
       RETURNING code, name, entry_count, created_at, updated_at`,
    )
    .bind(code, userId, doc.name, document, doc.entries.length, now, now,
      userId, doc.name, userId, MAX_ACCOUNT_PROFILES,
      userId, doc.name, documentBytes, MAX_ACCOUNT_PROFILE_BYTES)
    .first<ShareSummary>();
  if (!row) throw new ProfileLimitError();
  return { ...row, created: row.code === code };
}

export interface SharedProfile extends ShareSummary {
  owner: { login: string; avatar_url: string | null };
  profile: ProfileDocument;
}

export async function profileByCode(db: D1Database, code: string): Promise<SharedProfile | null> {
  const row = await db
    .prepare(
      `SELECT p.*, u.login AS owner_login, u.avatar_url AS owner_avatar
       FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.code = ?`,
    )
    .bind(code)
    .first<ProfileRow & { owner_login: string; owner_avatar: string | null }>();
  if (!row) return null;
  return {
    code: row.code,
    name: row.name,
    entry_count: row.entry_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
    owner: { login: row.owner_login, avatar_url: row.owner_avatar },
    profile: JSON.parse(row.document) as ProfileDocument,
  };
}

export class InvalidProfilePageError extends Error {}

export interface ProfilePage {
  shares: ShareSummary[];
  next_cursor: string | null;
}

export async function listProfiles(
  db: D1Database,
  userId: string,
  { cursor = null, limit = PROFILE_PAGE_SIZE }: { cursor?: string | null; limit?: number } = {},
): Promise<ProfilePage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PROFILE_PAGE_SIZE) {
    throw new InvalidProfilePageError(`limit must be an integer from 1 to ${MAX_PROFILE_PAGE_SIZE}.`);
  }
  const [createdAt = "", code = "", ...extra] = cursor?.split("/") ?? [];
  if (cursor !== null && (extra.length > 0 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt)
    || !Number.isFinite(Date.parse(createdAt)) || normalizeShareCode(code) !== code || !code)) {
    throw new InvalidProfilePageError("Invalid profile page cursor.");
  }
  const res = await db
    .prepare(
      `SELECT code, name, entry_count, created_at, updated_at FROM profiles
       WHERE user_id = ? AND (? IS NULL OR (created_at, code) < (?, ?))
       ORDER BY created_at DESC, code DESC LIMIT ?`,
    )
    .bind(userId, cursor, createdAt, code, limit + 1)
    .all<ShareSummary>();
  const shares = res.results.slice(0, limit);
  const last = shares.at(-1);
  return {
    shares,
    next_cursor: res.results.length > limit && last ? `${last.created_at}/${last.code}` : null,
  };
}

export async function deleteProfile(db: D1Database, userId: string, code: string): Promise<boolean> {
  const res = await db.prepare("DELETE FROM profiles WHERE code = ? AND user_id = ?").bind(code, userId).run();
  return (res.meta.changes ?? 0) > 0;
}

// --- Account page: tokens a user can see and revoke -----------------------

export interface TokenSummary {
  token_hash: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
}

export async function listTokens(db: D1Database, userId: string): Promise<TokenSummary[]> {
  const res = await db
    .prepare(
      `SELECT token_hash, label, created_at, last_used_at FROM tokens
       WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .bind(userId)
    .all<TokenSummary>();
  return res.results;
}

/** Revoke by hash (the raw token never reaches the browser). */
export async function deleteTokenForUser(db: D1Database, userId: string, hash: string): Promise<boolean> {
  const res = await db.prepare("DELETE FROM tokens WHERE token_hash = ? AND user_id = ?").bind(hash, userId).run();
  return (res.meta.changes ?? 0) > 0;
}
