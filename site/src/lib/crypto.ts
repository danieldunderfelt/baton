/** Hex SHA-256: sessions, CLI tokens and device codes are stored hashed. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Unbiased random string over `alphabet` (rejection sampling). */
export function randomString(alphabet: string, length: number): string {
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) {
      if (b < limit) out += alphabet[b % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

const URL_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** A secret with ~`bits` of entropy, URL-safe. */
export function randomSecret(bits = 192): string {
  return randomString(URL_SAFE, Math.ceil(bits / Math.log2(URL_SAFE.length)));
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isoAfter(ms: number, from = Date.now()): string {
  return new Date(from + ms).toISOString();
}
