import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

import { nowIso } from "../store/store.ts";
import {
  diffPriors,
  importPriors,
  setActiveProfile,
  type ImportDiff,
  type PriorDiff,
  type PriorEntry,
} from "./evalStore.ts";
import { parseProfileDocument, type ProfileDocument, type ProfileEntry } from "./profileDocument.ts";

export {
  parseProfileDocument,
  renderProfile,
  validateProfileDocument,
  yamlValue,
  type ProfileDocument,
  type ProfileEntry,
} from "./profileDocument.ts";

/**
 * The shareable profile file on this machine: export from the store, import
 * into it. The document format itself — parse, validate, render — lives in
 * profileDocument.ts so the sharing site runs the identical validator.
 */

/**
 * Reads a profile's priors out as a portable document. Only the priors table is
 * touched: the accumulator, targets, and runs are local evidence and stay home.
 */
export function exportProfile(db: Database, profile: string, at = nowIso()): ProfileDocument {
  const entries = db
    .query<ProfileEntry, [string]>(
      `SELECT model, category, mean, weight, as_of
       FROM priors WHERE profile = ? ORDER BY model, category`,
    )
    .all(profile);
  if (entries.length === 0) {
    throw new Error(`Profile "${profile}" has no priors to export.`);
  }
  // Defense in depth for the portability guarantee: both write paths already
  // enforce canonical ids, but the export is the boundary where a leak would
  // become someone else's problem — refuse rather than ship a fingerprint.
  for (const e of entries) {
    if (/[:/@]/.test(e.model)) {
      throw new Error(
        `Refusing to export: "${e.model}" is not a canonical model id (looks like a target or route). Fix the priors row before sharing.`,
      );
    }
  }
  return { name: profile, exported_at: at, entries };
}

export interface ImportOptions {
  /** Store the priors under a different local profile name. */
  name?: string;
  /** Activation is explicit — importing never switches the prior underneath you. */
  activate?: boolean;
  /** Provenance to stamp instead of the document's name, e.g. `login/name` for a share. */
  source?: string;
}

/**
 * Imports a shared profile file. Validation happens before any write, so a
 * malformed file leaves the store untouched, and the diff from `importPriors`
 * is returned as-is: nothing is reweighted behind the user's back.
 */
export function importProfileFile(
  db: Database,
  filePath: string,
  opts: ImportOptions = {},
  at = nowIso(),
): ImportDiff {
  return importProfileDocument(db, parseProfileDocument(read(filePath), filePath), opts, at);
}

/** The import itself, for a document that did not come from a file. */
export function importProfileDocument(
  db: Database,
  doc: ProfileDocument,
  opts: ImportOptions = {},
  at = nowIso(),
): ImportDiff {
  const profile = opts.name ?? doc.name;
  // Provenance is the document's own name (or where it was shared from):
  // renaming locally must not hide where the numbers came from.
  const diff = importPriors(db, profile, priorEntriesOf(doc), opts.source ?? doc.name, at);
  return opts.activate ? { ...diff, revision: setActiveProfile(db, profile) } : diff;
}

/**
 * The document as the prior entries a write would store. `as_of` travels with
 * the entry: a shared opinion is as old as it says it is, and re-stamping it
 * with the import time would silently freshen it.
 */
export function priorEntriesOf(doc: ProfileDocument): PriorEntry[] {
  return doc.entries.map((e) => ({
    model: e.model,
    category: e.category,
    mean: e.mean,
    weight: e.weight,
    asOf: e.as_of,
  }));
}

/**
 * What `importProfileFile` would change, without writing. It resolves the same
 * entries, provenance and clock as the commit does, so the confirmation a user
 * approves against is the diff they actually get — a preview blind to `as_of`
 * or source would call a restamped entry unchanged and then change it anyway.
 */
export function diffProfileDocument(
  db: Database,
  doc: ProfileDocument,
  profile = doc.name,
  at = nowIso(),
  source = doc.name,
): PriorDiff {
  return diffPriors(db, profile, priorEntriesOf(doc), { source: `imported:${source}`, at });
}

function read(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(
      `Cannot read profile file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
