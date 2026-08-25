/**
 * Agentic discovery (PLAN.md §Agentic discovery). One adapter format, two
 * provenances, not equal trust: built-ins are pinned and tested; discovered
 * specs enter QUARANTINED and Baton executes nothing from them until a human
 * approves the exact executable, argv, and env names in the trusted CLI —
 * approval precedes the canary, the canary precedes activation.
 */
import type { AdapterSpec } from "../adapters/types.ts";

export type DiscoveredStatus = "quarantined" | "approved" | "active" | "stale" | "rejected";

export interface DiscoveredAdapter {
  app: string;
  spec: AdapterSpec;
  /**
   * sha256 of the canonical serialization of `spec` — the identity of the thing
   * under review. Every lifecycle step (approve, canary, activate, reject) is
   * bound to it, so a spec resubmitted mid-flight can never inherit a decision
   * that was made about a different spec with the same app name.
   */
  digest: string;
  status: DiscoveredStatus;
  submittedAt: string;
  reviewedAt?: string;
  /** Binary version at canary time; a bump at detect marks the adapter stale. */
  binaryVersion?: string;
  notes?: string;
}

/** The canary asks for this token verbatim to verify extraction end-to-end. */
export const CANARY_TOKEN = "BATON_CANARY";

/**
 * Structural validation rejects anything outside the declarative format:
 * argv arrays only (no element may contain shell metacharacters), placeholders
 * present exactly where expected, extraction declarative, patterns are plain
 * substrings. Help text and CLI output are untrusted content — the discovery
 * brief says so and the validator assumes so.
 */
export const FORBIDDEN_ARGV_CHARS = /[;&|<>`$(){}\n\r]/;

/**
 * C0/C1 control characters, bidi overrides and zero-width joiners. A spec is
 * read by a human in a terminal before it is allowed to run, and a field
 * carrying `ESC[2J` or a right-to-left override can repaint or reorder that
 * review — so no string field may contain one, anywhere.
 */
const CONTROL_OR_BIDI_CLASS =
  "[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\ufeff\\ufff9-\\ufffb]";
export const CONTROL_OR_BIDI_CHARS = new RegExp(CONTROL_OR_BIDI_CLASS);
const CONTROL_OR_BIDI_CHARS_G = new RegExp(CONTROL_OR_BIDI_CLASS, "g");

/** Renders a string safe to print on a terminal: invisibles become `\uXXXX`. */
export function printable(text: string): string {
  return text.replace(
    CONTROL_OR_BIDI_CHARS_G,
    (c) => `\\u${(c.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
}
