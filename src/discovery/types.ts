import type { AdapterSpec } from "../adapters/types.ts";

export type DiscoveredStatus = "enabled" | "disabled";
export interface DiscoveredAdapter {
  app: string;
  spec: AdapterSpec;
  /** Internal revision identity for concurrent registration and diagnostics. */
  digest: string;
  status: DiscoveredStatus;
  submittedAt: string;
  diagnostic?: { testedAt: string; passed: boolean; binaryVersion?: string; note?: string };
}
export const CANARY_TOKEN = "BATON_CANARY";

const CONTROL_OR_BIDI_CLASS =
  "[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\ufeff\\ufff9-\\ufffb]";
const CONTROL_OR_BIDI_CHARS_G = new RegExp(CONTROL_OR_BIDI_CLASS, "g");

/** Renders a string safe to print on a terminal: invisibles become `\uXXXX`. */
export function printable(text: string): string {
  return text.replace(
    CONTROL_OR_BIDI_CHARS_G,
    (c) => `\\u${(c.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
}
