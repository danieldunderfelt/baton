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
