/** Ten characters without look-alikes, about 49 bits of entropy, grouped as xxxxx-xxxxx. */
export const SHARE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
export const SHARE_LENGTH = 10;

export function formatShareCode(compact: string): string {
  return `${compact.slice(0, 5)}-${compact.slice(5)}`;
}

export function normalizeShareCode(text: string): string | null {
  const compact = text.toLowerCase().replace(/[-\s]/g, "");
  if (compact.length !== SHARE_LENGTH) return null;
  for (const ch of compact) if (!SHARE_ALPHABET.includes(ch)) return null;
  return formatShareCode(compact);
}
