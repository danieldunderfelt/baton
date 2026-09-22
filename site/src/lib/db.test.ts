import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import {
  approveDevice, createDeviceCode, deleteProfile, DeviceLimitError, DEVICE_RATE_WINDOW_MS,
  InvalidProfilePageError, listProfiles, MAX_ACCOUNT_PROFILES, MAX_ACCOUNT_PROFILE_BYTES,
  MAX_CLIENT_DEVICE_STARTS, MAX_CLIENT_PENDING_DEVICES, MAX_PENDING_DEVICES,
  ProfileLimitError, purgeExpired, redeemDevice, upsertProfile, upsertUser,
} from "./db.ts";
import { nowIso } from "./crypto.ts";
import { validateProfileDocument } from "../../../src/eval/profileDocument.ts";

const worker = new Miniflare({
  workers: [
    {
      config: {
        type: "worker",
        name: "tests",
        compatibilityDate: "2026-09-09",
        manifest: {
          mainModule: "worker.js",
          modules: {
            "worker.js": {
              type: "esm",
              contents: 'export default { fetch() { return new Response("ok"); } }',
            },
          },
        },
        env: { DB: { type: "d1", id: "test-db" } },
      },
    },
  ],
  telemetry: { enabled: false },
});
const db = await worker.getD1Database("DB");
beforeAll(async () => {
  const directory = new URL("../../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    const migration = readFileSync(new URL(name, directory), "utf8");
    // D1 exec accepts one statement per line.
    await db.exec(migration.replace(/^--.*$/gm, "").replace(/\n/g, " "));
  }
});
beforeEach(async () => {
  await db.exec("DELETE FROM device_starts; DELETE FROM device_codes; DELETE FROM profiles; DELETE FROM tokens; DELETE FROM sessions; DELETE FROM users;");
});
afterAll(() => worker.dispose());

test("concurrent first sign-ins keep one user identity", async () => {
  const github = { id: 123, login: "alice", avatar_url: null };
  const users = await Promise.all([upsertUser(db, github), upsertUser(db, github)]);
  expect(users[0]!.id).toBe(users[1]!.id);
});

test("concurrent first shares keep one stable link", async () => {
  const user = await upsertUser(db, { id: 124, login: "bob", avatar_url: null });
  const doc = { name: "team", exported_at: nowIso(), entries: [] };
  const shares = await Promise.all([
    upsertProfile(db, user.id, doc),
    upsertProfile(db, user.id, doc),
  ]);
  expect(shares[0]!.code).toBe(shares[1]!.code);
  expect(shares.filter((share) => share.created)).toHaveLength(1);
});

test("only one concurrent poll can redeem an approved device code", async () => {
  const user = await upsertUser(db, { id: 125, login: "carol", avatar_url: null });
  const device = await createDeviceCode(db, "test", "192.0.2.1");
  await approveDevice(db, device.user_code, user.id);
  const results = await Promise.all([
    redeemDevice(db, device.device_code),
    redeemDevice(db, device.device_code),
  ]);
  expect(results.filter((result) => result.status === "ok")).toHaveLength(1);
});

test("a failed token insert leaves the approved code redeemable", async () => {
  const user = await upsertUser(db, { id: 126, login: "dave", avatar_url: null });
  const device = await createDeviceCode(db, "fail-test", "192.0.2.1");
  await approveDevice(db, device.user_code, user.id);
  await db.exec(
    "CREATE TRIGGER fail_token BEFORE INSERT ON tokens WHEN NEW.label = 'fail-test' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;",
  );
  await expect(redeemDevice(db, device.device_code)).rejects.toThrow("simulated failure");
  await db.exec("DROP TRIGGER fail_token;");
  const result = await redeemDevice(db, device.device_code);
  expect(result.status).toBe("ok");
});

test("one client cannot occupy the sign-in pool, even with concurrent starts", async () => {
  const starts = await Promise.allSettled(Array.from({ length: 20 }, () => createDeviceCode(db, "cli", "192.0.2.1")));
  expect(starts.filter((start) => start.status === "fulfilled")).toHaveLength(MAX_CLIENT_PENDING_DEVICES);
  for (const start of starts) {
    if (start.status === "rejected") expect(start.reason).toBeInstanceOf(DeviceLimitError);
  }
  await expect(createDeviceCode(db, "other client", "192.0.2.2")).resolves.toHaveProperty("device_code");
  const history = await db.prepare("SELECT COUNT(*) AS n FROM device_starts").first<{ n: number }>();
  expect(history?.n).toBe(MAX_CLIENT_PENDING_DEVICES + 1);
  const stored = await db.prepare("SELECT client_hash FROM device_codes LIMIT 1").first<{ client_hash: string }>();
  expect(stored?.client_hash).toMatch(/^[a-f0-9]{64}$/);
});

test("concurrent clients cannot exceed global sign-in capacity", async () => {
  await db.prepare(`WITH RECURSIVE slots(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM slots WHERE n < ?)
    INSERT INTO device_codes (device_code_hash, user_code, label, created_at, expires_at)
    SELECT 'hash-' || n, 'code-' || n, 'legacy', ?, ? FROM slots`)
    .bind(MAX_PENDING_DEVICES - 2, nowIso(), new Date(Date.now() + 60_000).toISOString()).run();
  const starts = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => createDeviceCode(db, "cli", `192.0.2.${i}`)));
  expect(starts.filter((start) => start.status === "fulfilled")).toHaveLength(2);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM device_codes").first<number>("n")).toBe(MAX_PENDING_DEVICES);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM device_starts").first<number>("n")).toBe(2);
});

test("redeeming codes does not bypass the per-client start rate", async () => {
  const user = await upsertUser(db, { id: 127, login: "eve", avatar_url: null });
  for (let i = 0; i < MAX_CLIENT_DEVICE_STARTS; i++) {
    const device = await createDeviceCode(db, "cli", "192.0.2.1");
    await approveDevice(db, device.user_code, user.id);
    expect((await redeemDevice(db, device.device_code)).status).toBe("ok");
  }
  await expect(createDeviceCode(db, "cli", "192.0.2.1")).rejects.toBeInstanceOf(DeviceLimitError);
  await expect(createDeviceCode(db, "cli", "192.0.2.2")).resolves.toHaveProperty("device_code");
  const expired = new Date(Date.now() - DEVICE_RATE_WINDOW_MS - 1000).toISOString();
  await db.prepare("UPDATE device_starts SET created_at = ?").bind(expired).run();
  await expect(createDeviceCode(db, "cli", "192.0.2.1")).resolves.toHaveProperty("device_code");
  await purgeExpired(db);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM device_starts").first<number>("n")).toBe(1);
});

test("expired codes release capacity before housekeeping runs", async () => {
  await Promise.all(Array.from({ length: MAX_CLIENT_PENDING_DEVICES }, () => createDeviceCode(db, "cli", "192.0.2.1")));
  await db.prepare("UPDATE device_codes SET expires_at = ?").bind(new Date(Date.now() - 1000).toISOString()).run();
  await expect(createDeviceCode(db, "cli", "192.0.2.1")).resolves.toHaveProperty("device_code");
  await purgeExpired(db);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM device_codes").first<number>("n")).toBe(1);
});

test("start history and code creation roll back together", async () => {
  await db.exec("CREATE TRIGGER fail_start BEFORE INSERT ON device_starts BEGIN SELECT RAISE(ABORT, 'simulated history failure'); END;");
  try {
    await expect(createDeviceCode(db, "cli", "192.0.2.1")).rejects.toThrow("simulated history failure");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM device_codes").first<number>("n")).toBe(0);
  } finally {
    await db.exec("DROP TRIGGER fail_start;");
  }
});

test("account profile count is atomic, replacement keeps its link, and deletion releases capacity", async () => {
  const user = await upsertUser(db, { id: 128, login: "frank", avatar_url: null });
  const documents = Array.from({ length: MAX_ACCOUNT_PROFILES - 1 }, (_, i) => ({ name: `profile-${i}`, exported_at: nowIso(), entries: [] }));
  const initial = await Promise.all(documents.map((doc) => upsertProfile(db, user.id, doc)));
  const shares = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => upsertProfile(db, user.id,
    { name: `concurrent-${i}`, exported_at: nowIso(), entries: [] })));
  expect(shares.filter((share) => share.status === "fulfilled")).toHaveLength(1);
  for (const share of shares) {
    if (share.status === "rejected") expect(share.reason).toBeInstanceOf(ProfileLimitError);
  }
  const replacement = await upsertProfile(db, user.id, documents[0]!);
  expect(replacement.code).toBe(initial[0]!.code);
  expect(replacement.created).toBe(false);
  const next = { name: "next", exported_at: nowIso(), entries: [] };
  await expect(upsertProfile(db, user.id, next)).rejects.toBeInstanceOf(ProfileLimitError);
  expect(await deleteProfile(db, user.id, replacement.code)).toBe(true);
  await expect(upsertProfile(db, user.id, next)).resolves.toHaveProperty("created", true);
  const other = await upsertUser(db, { id: 129, login: "grace", avatar_url: null });
  await expect(upsertProfile(db, other.id, next)).resolves.toHaveProperty("created", true);
});

test("concurrent profile writes count UTF-8 storage bytes and preserve a rejected replacement", async () => {
  const user = await upsertUser(db, { id: 130, login: "heidi", avatar_url: null });
  const exportedAt = nowIso();
  const document = (i: number, category = "界".repeat(30)) => validateProfileDocument({
    name: `profile-${String(i).padStart(3, "0")}`,
    exported_at: exportedAt,
    entries: Array.from({ length: 500 }, (_, j) => ({
      model: `model-${j}`.padEnd(90, "x"), category, mean: 3, weight: 5, as_of: exportedAt,
    })),
  });
  const bytes = new TextEncoder().encode(JSON.stringify(document(0))).byteLength;
  expect(bytes).toBeLessThan(256 * 1024);
  const fits = Math.floor(MAX_ACCOUNT_PROFILE_BYTES / bytes);
  expect(fits).toBeLessThan(MAX_ACCOUNT_PROFILES);
  const initial = await Promise.all(Array.from({ length: fits - 1 }, (_, i) => upsertProfile(db, user.id, document(i))));
  const concurrent = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => upsertProfile(db, user.id, document(fits + i))));
  expect(concurrent.filter((share) => share.status === "fulfilled")).toHaveLength(1);
  const total = await db.prepare("SELECT SUM(document_bytes) AS n FROM profiles WHERE user_id = ?").bind(user.id).first<number>("n");
  expect(total).toBe(fits * bytes);
  expect(total).toBeLessThanOrEqual(MAX_ACCOUNT_PROFILE_BYTES);
  const remaining = MAX_ACCOUNT_PROFILE_BYTES - fits * bytes;
  const filler = document(98);
  filler.entries = filler.entries.slice(0, Math.max(0, Math.floor((remaining - 1024) * 500 / bytes)));
  await upsertProfile(db, user.id, filler);
  await expect(upsertProfile(db, user.id, document(0, "界".repeat(35)))).rejects.toBeInstanceOf(ProfileLimitError);
  expect(await db.prepare("SELECT document_bytes FROM profiles WHERE code = ?").bind(initial[0]!.code).first<number>("document_bytes")).toBe(bytes);
  await upsertProfile(db, user.id, { name: document(0).name, exported_at: exportedAt, entries: [] });
  await expect(upsertProfile(db, user.id, document(99))).resolves.toHaveProperty("created", true);
});

test("profile byte accounting also follows writes from older deployments", async () => {
  const user = await upsertUser(db, { id: 133, login: "legacy", avatar_url: null });
  const document = JSON.stringify({ name: "旧 profile", exported_at: nowIso(), entries: [] });
  await db.prepare(`INSERT INTO profiles (code, user_id, name, document, entry_count, created_at, updated_at)
    VALUES ('aaaaa-aaaaa', ?, 'legacy', ?, 0, ?, ?)`)
    .bind(user.id, document, nowIso(), nowIso()).run();
  expect(await db.prepare("SELECT document_bytes FROM profiles WHERE user_id = ?").bind(user.id).first<number>("document_bytes"))
    .toBe(new TextEncoder().encode(document).byteLength);
  const updated = document.replace("旧 profile", "new profile");
  await db.prepare("UPDATE profiles SET document = ? WHERE user_id = ?").bind(updated, user.id).run();
  expect(await db.prepare("SELECT SUM(document_bytes) AS bytes FROM profiles WHERE user_id = ?").bind(user.id).first<number>("bytes"))
    .toBe(new TextEncoder().encode(updated).byteLength);
});

test("profile pagination is bounded and stable across tied timestamps, updates and cursor deletion", async () => {
  const user = await upsertUser(db, { id: 131, login: "ivan", avatar_url: null });
  const other = await upsertUser(db, { id: 132, login: "judy", avatar_url: null });
  const documents = Array.from({ length: 31 }, (_, i) => ({ name: `profile-${i}`, exported_at: nowIso(), entries: [] }));
  await Promise.all(documents.map((doc) => upsertProfile(db, user.id, doc)));
  await upsertProfile(db, other.id, documents[0]!);
  await db.prepare("UPDATE profiles SET created_at = ?").bind("2026-09-01T00:00:00.000Z").run();
  const expected = (await listProfiles(db, user.id, { limit: 100 })).shares.map((share) => share.code);
  expect((await listProfiles(db, user.id)).shares).toHaveLength(25);
  const first = await listProfiles(db, user.id, { limit: 7 });
  const seen = first.shares.map((share) => share.code);
  await deleteProfile(db, user.id, first.shares.at(-1)!.code);
  const toUpdate = documents.find((doc) => first.shares.every((share) => share.name !== doc.name));
  expect(toUpdate).toBeDefined();
  await upsertProfile(db, user.id, toUpdate!);
  let cursor = first.next_cursor;
  while (cursor) {
    const page = await listProfiles(db, user.id, { limit: 7, cursor });
    expect(page.shares.length).toBeLessThanOrEqual(7);
    seen.push(...page.shares.map((share) => share.code));
    cursor = page.next_cursor;
  }
  expect(seen).toEqual(expected);
  expect(new Set(seen).size).toBe(31);
});

test("profile page inputs reject invalid cursors and unbounded limits", async () => {
  for (const limit of [0, -1, 101, 1.5, NaN, Infinity]) {
    await expect(listProfiles(db, "unknown", { limit })).rejects.toBeInstanceOf(InvalidProfilePageError);
  }
  for (const cursor of ["", "garbage", "2026-09-01T00:00:00.000Z/", "2026-99-99T00:00:00.000Z/aaaaa-aaaaa", "2026-09-01T00:00:00.000Z/aaaaa-aaaaa/extra"]) {
    await expect(listProfiles(db, "unknown", { cursor })).rejects.toBeInstanceOf(InvalidProfilePageError);
  }
  expect(await listProfiles(db, "unknown")).toEqual({ shares: [], next_cursor: null });
});
