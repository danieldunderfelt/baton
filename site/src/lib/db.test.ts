import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { approveDevice, createDeviceCode, redeemDevice, upsertProfile, upsertUser } from "./db.ts";
import { nowIso } from "./crypto.ts";

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
  const migration = readFileSync(
    new URL("../../migrations/0001_init.sql", import.meta.url),
    "utf8",
  );
  // D1 exec accepts one statement per line.
  await db.exec(migration.replace(/^--.*$/gm, "").replace(/\n/g, " "));
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
  const device = await createDeviceCode(db, "test");
  await approveDevice(db, device.user_code, user.id);
  const results = await Promise.all([
    redeemDevice(db, device.device_code),
    redeemDevice(db, device.device_code),
  ]);
  expect(results.filter((result) => result.status === "ok")).toHaveLength(1);
});

test("a failed token insert leaves the approved code redeemable", async () => {
  const user = await upsertUser(db, { id: 126, login: "dave", avatar_url: null });
  const device = await createDeviceCode(db, "fail-test");
  await approveDevice(db, device.user_code, user.id);
  await db.exec(
    "CREATE TRIGGER fail_token BEFORE INSERT ON tokens WHEN NEW.label = 'fail-test' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;",
  );
  await expect(redeemDevice(db, device.device_code)).rejects.toThrow("simulated failure");
  await db.exec("DROP TRIGGER fail_token;");
  const result = await redeemDevice(db, device.device_code);
  expect(result.status).toBe("ok");
});
