import { isoAfter, nowIso, randomSecret, sha256Hex } from "./crypto.ts";
import { newShareCode, newUserCode } from "./codes.ts";
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

export async function upsertUser(
  db: D1Database,
  github: { id: number; login: string; avatar_url: string | null },
): Promise<User> {
  const existing = await db
    .prepare("SELECT * FROM users WHERE github_id = ?")
    .bind(github.id)
    .first<User>();
  if (existing) {
    if (existing.login !== github.login || existing.avatar_url !== github.avatar_url) {
      await db
        .prepare("UPDATE users SET login = ?, avatar_url = ? WHERE id = ?")
        .bind(github.login, github.avatar_url, existing.id)
        .run();
    }
    return { ...existing, login: github.login, avatar_url: github.avatar_url };
  }
  const user: User = {
    id: `u_${randomSecret(96)}`,
    github_id: github.id,
    login: github.login,
    avatar_url: github.avatar_url,
    created_at: nowIso(),
  };
  await db
    .prepare("INSERT INTO users (id, github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(user.id, user.github_id, user.login, user.avatar_url, user.created_at)
    .run();
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

export async function createDeviceCode(db: D1Database, label: string): Promise<DeviceStart> {
  const deviceCode = randomSecret();
  const userCode = newUserCode();
  await db
    .prepare(
      `INSERT INTO device_codes (device_code_hash, user_code, label, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(await sha256Hex(deviceCode), userCode, label, nowIso(), isoAfter(DEVICE_TTL_MS))
    .run();
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

/** The CLI's poll: once approved, mint the token and burn the device code. */
export async function redeemDevice(db: D1Database, rawDeviceCode: string): Promise<DeviceRedeem> {
  const hash = await sha256Hex(rawDeviceCode);
  const row = await db
    .prepare("SELECT user_code, label, user_id, expires_at FROM device_codes WHERE device_code_hash = ?")
    .bind(hash)
    .first<PendingDevice>();
  if (!row) return { status: "invalid" };
  if (row.expires_at <= nowIso()) {
    await db.prepare("DELETE FROM device_codes WHERE device_code_hash = ?").bind(hash).run();
    return { status: "expired" };
  }
  if (!row.user_id) return { status: "pending" };
  const user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(row.user_id).first<User>();
  if (!user) return { status: "invalid" };
  const token = `bt_${randomSecret()}`;
  await db.batch([
    db
      .prepare("INSERT INTO tokens (token_hash, user_id, label, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(token), user.id, row.label, nowIso()),
    db.prepare("DELETE FROM device_codes WHERE device_code_hash = ?").bind(hash),
  ]);
  return { status: "ok", token, login: user.login };
}

/** Housekeeping on a path that is rare anyway (each `baton login`). */
export async function purgeExpired(db: D1Database): Promise<void> {
  const now = nowIso();
  await db.batch([
    db.prepare("DELETE FROM device_codes WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
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
  const existing = await db
    .prepare("SELECT code, created_at FROM profiles WHERE user_id = ? AND name = ?")
    .bind(userId, doc.name)
    .first<{ code: string; created_at: string }>();
  if (existing) {
    await db
      .prepare("UPDATE profiles SET document = ?, entry_count = ?, updated_at = ? WHERE code = ?")
      .bind(document, doc.entries.length, now, existing.code)
      .run();
    return {
      code: existing.code,
      name: doc.name,
      entry_count: doc.entries.length,
      created_at: existing.created_at,
      updated_at: now,
      created: false,
    };
  }
  const code = newShareCode();
  await db
    .prepare(
      `INSERT INTO profiles (code, user_id, name, document, entry_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(code, userId, doc.name, document, doc.entries.length, now, now)
    .run();
  return { code, name: doc.name, entry_count: doc.entries.length, created_at: now, updated_at: now, created: true };
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

export async function listProfiles(db: D1Database, userId: string): Promise<ShareSummary[]> {
  const res = await db
    .prepare(
      `SELECT code, name, entry_count, created_at, updated_at FROM profiles
       WHERE user_id = ? ORDER BY updated_at DESC`,
    )
    .bind(userId)
    .all<ShareSummary>();
  return res.results;
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
