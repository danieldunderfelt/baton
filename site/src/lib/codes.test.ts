import { describe, expect, test } from "bun:test";

import { newShareCode, newUserCode, normalizeShareCode, normalizeUserCode } from "./codes.ts";

describe("share codes", () => {
  test("generate in canonical form and round-trip through normalization", () => {
    for (let i = 0; i < 50; i++) {
      const code = newShareCode();
      expect(code).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]{5}-[23456789abcdefghjkmnpqrstuvwxyz]{5}$/);
      expect(normalizeShareCode(code)).toBe(code);
      expect(normalizeShareCode(code.replace("-", "").toUpperCase())).toBe(code);
    }
  });

  test("reject the wrong length or look-alike characters", () => {
    expect(normalizeShareCode("abcde-fgh")).toBeNull();
    expect(normalizeShareCode("abcde-fghj0")).toBeNull(); // 0 is not in the alphabet
    expect(normalizeShareCode("../../etc")).toBeNull();
  });
});

describe("user codes", () => {
  test("generate in canonical form and accept sloppy input", () => {
    const code = newUserCode();
    expect(code).toMatch(/^[BCDFGHJKMNPQRSTVWXZ2-9]{4}-[BCDFGHJKMNPQRSTVWXZ2-9]{4}$/);
    expect(normalizeUserCode(code.toLowerCase().replace("-", " "))).toBe(code);
    expect(normalizeUserCode("ABCD")).toBeNull();
  });
});
