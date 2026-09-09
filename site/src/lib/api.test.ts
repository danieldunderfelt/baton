import { expect, test } from "bun:test";
import { readJson, readJsonObject } from "./api.ts";

test("JSON input must be an object at device endpoints", async () => {
  for (const body of ["null", "[]", "true", '"text"']) {
    await expect(
      readJsonObject(new Request("https://baton.test", { method: "POST", body })),
    ).rejects.toMatchObject({ status: 400 });
  }
});

test("request limits count UTF-8 bytes, even without Content-Length", async () => {
  const request = new Request("https://baton.test", {
    method: "POST",
    body: JSON.stringify({ text: "界".repeat(100_000) }),
  });
  await expect(readJson(request)).rejects.toMatchObject({ status: 413 });
});

test("an oversized stream is cancelled without reading the rest", async () => {
  let cancelled = false;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(128 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(
    readJson(new Request("https://baton.test", { method: "POST", body })),
  ).rejects.toMatchObject({ status: 413 });
  expect(cancelled).toBe(true);
  expect(pulls).toBeLessThan(6);
});
