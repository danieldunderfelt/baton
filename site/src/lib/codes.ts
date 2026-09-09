import { randomString } from "./crypto.ts";

import { formatShareCode, SHARE_ALPHABET, SHARE_LENGTH } from "../../../src/eval/shareCode.ts";
export { normalizeShareCode } from "../../../src/eval/shareCode.ts";

export function newShareCode(): string {
  return formatShareCode(randomString(SHARE_ALPHABET, SHARE_LENGTH));
}

/**
 * Device user codes: eight characters typed by a human from a terminal into a
 * browser. Uppercase consonants and digits, shown as `XXXX-XXXX`, valid for a
 * few minutes and useless without the device secret the CLI holds.
 */
const USER_ALPHABET = "BCDFGHJKMNPQRSTVWXZ23456789";
const USER_LENGTH = 8;

export function newUserCode(): string {
  return format(randomString(USER_ALPHABET, USER_LENGTH), 4);
}

export function normalizeUserCode(text: string): string | null {
  const compact = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact.length !== USER_LENGTH) return null;
  for (const ch of compact) if (!USER_ALPHABET.includes(ch)) return null;
  return format(compact, 4);
}

function format(compact: string, group: number): string {
  return `${compact.slice(0, group)}-${compact.slice(group)}`;
}
