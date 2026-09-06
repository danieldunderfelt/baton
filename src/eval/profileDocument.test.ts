import { describe, expect, test } from "bun:test";

import { parseProfileDocument, validateProfileDocument } from "./profileDocument.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function doc(entry: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return { name: "mine", exported_at: NOW, entries: [entry], ...extra };
}

describe("shared documents are terminal-safe", () => {
  test("rejects control characters in category, model and name", () => {
    const osc52 = `review${String.fromCharCode(27)}]52;c;aGk=${String.fromCharCode(7)}`;
    expect(() => validateProfileDocument(doc({ model: "kimi-k3", category: osc52, mean: 4 }), "t", NOW)).toThrow(
      /category/,
    );
    expect(() =>
      validateProfileDocument(doc({ model: `kimi${String.fromCharCode(155)}k3`, mean: 4 }), "t", NOW),
    ).toThrow(/model/);
    expect(() =>
      validateProfileDocument(doc({ model: "kimi-k3", mean: 4 }, { name: `a${String.fromCharCode(10)}b` }), "t", NOW),
    ).toThrow(/name/);
  });

  test("still accepts free-text categories with spaces", () => {
    const parsed = validateProfileDocument(doc({ model: "kimi-k3", category: "code review", mean: 4 }), "t", NOW);
    expect(parsed.entries[0]?.category).toBe("code review");
  });
});

describe("dates cannot be from the future", () => {
  test("clamps as_of and exported_at beyond a day of skew to now", () => {
    const parsed = validateProfileDocument(
      doc({ model: "kimi-k3", mean: 4, as_of: "2099-01-01T00:00:00.000Z" }, { exported_at: "2098-01-01T00:00:00.000Z" }),
      "t",
      NOW,
    );
    expect(parsed.exported_at).toBe(NOW);
    expect(parsed.entries[0]?.as_of).toBe(NOW);
  });

  test("leaves dates within the skew allowance alone", () => {
    const soon = "2026-01-01T12:00:00.000Z";
    const parsed = parseProfileDocument(JSON.stringify(doc({ model: "kimi-k3", mean: 4, as_of: soon })), "t", NOW);
    expect(parsed.entries[0]?.as_of).toBe(soon);
  });
});
