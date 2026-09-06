/**
 * The shareable profile document (PLAN.md §Layering and sharing), as pure
 * data: parse, validate, render. No store, no filesystem, no Bun APIs, so the
 * same validator runs in the CLI and in the sharing site's Worker — a file
 * that one accepts, the other accepts too.
 *
 * A profile is **priors only, canonical models only**: no execution targets,
 * no instances, no machine details, no prompts. That is the portability
 * guarantee, so the parser rejects any key outside the format rather than
 * ignoring it — a file carrying local fingerprints is a bug in whatever wrote
 * it, not something to silently drop.
 *
 * The format is a small, hand-rendered YAML subset (JSON is accepted too, since
 * the document is the same object either way). No YAML dependency: what we emit
 * is what we parse, and anything else is an error with a line number.
 */

import { DEFAULT_PRIOR_WEIGHT, PRIOR_WEIGHT_CAP } from "./types.ts";

export interface ProfileEntry {
  /** Canonical model id — never `app:instance/model` or a target fingerprint. */
  model: string;
  category: string;
  /** On the grade scale (1–5). */
  mean: number;
  /** Pseudo-observations, within PRIOR_WEIGHT_CAP. */
  weight: number;
  as_of: string;
}

export interface ProfileDocument {
  name: string;
  exported_at: string;
  entries: ProfileEntry[];
}

/** A profile bigger than this is not a set of opinions about models. */
export const MAX_PROFILE_ENTRIES = 500;

const PROFILE_HEADER =
  "# Baton profile — portable priors only: canonical models, no targets, instances, or prompts.";

export function renderProfile(doc: ProfileDocument): string {
  const lines = [
    PROFILE_HEADER,
    `name: ${yamlValue(doc.name)}`,
    `exported_at: ${yamlValue(doc.exported_at)}`,
    doc.entries.length === 0 ? "entries: []" : "entries:",
  ];
  for (const e of doc.entries) {
    lines.push(
      `  - model: ${yamlValue(e.model)}`,
      `    category: ${yamlValue(e.category)}`,
      `    mean: ${yamlValue(e.mean)}`,
      `    weight: ${yamlValue(e.weight)}`,
      `    as_of: ${yamlValue(e.as_of)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Parses and fully validates a profile document (YAML subset or JSON). */
export function parseProfileDocument(
  text: string,
  source = "<input>",
  now = new Date().toISOString(),
): ProfileDocument {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`${source}: profile file is empty.`);
  const raw = trimmed.startsWith("{") ? parseJson(trimmed, source) : parseYamlSubset(text, source);
  return validateProfileDocument(raw, source, now);
}

function parseJson(text: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${source}: not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
  if (!isRecord(parsed)) throw new Error(`${source}: profile must be a mapping.`);
  return parsed;
}

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*):(?:[ \t]+(.*))?$/;

/**
 * The exact subset `renderProfile` emits: top-level `key: value` lines plus an
 * `entries:` block of `- key: value` items. Anything else is rejected with the
 * offending line number — this is a shared file from someone else's machine,
 * so guessing at its intent is the wrong instinct.
 */
function parseYamlSubset(text: string, source: string): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  let entries: Record<string, unknown>[] | null = null;
  let item: Record<string, unknown> | null = null;

  text.split("\n").forEach((rawLine, index) => {
    const line = rawLine.replace(/\s+$/, "");
    const body = line.trimStart();
    if (!body || body.startsWith("#")) return;
    const fail = (why: string) => new Error(`${source}: line ${index + 1}: ${why}`);
    const indented = body.length < line.length;

    if (!indented) {
      if (body === "entries:" || body === "entries: []") {
        entries = [];
        doc.entries = entries;
        item = null;
        return;
      }
      const kv = keyValue(body, fail);
      if (kv.key === "entries") throw fail("`entries:` must be a list.");
      doc[kv.key] = scalar(kv.value, fail);
      return;
    }

    if (!entries) throw fail("indented line outside of `entries:`.");
    const isItem = body.startsWith("- ");
    if (isItem) {
      item = {};
      entries.push(item);
    } else if (!item) {
      throw fail("entry field before its `- ` item.");
    }
    const kv = keyValue(isItem ? body.slice(2).trimStart() : body, fail);
    item[kv.key] = scalar(kv.value, fail);
  });

  return doc;
}

function keyValue(body: string, fail: (why: string) => Error): { key: string; value: string } {
  const match = KEY_LINE.exec(body);
  if (!match) throw fail(`expected \`key: value\`, got \`${body}\`.`);
  if (match[2] === undefined) throw fail(`"${match[1]}" has no value.`);
  return { key: match[1]!, value: match[2] };
}

const NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?$/;

function scalar(text: string, fail: (why: string) => Error): unknown {
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw fail(`unterminated or invalid quoted string: ${text}`);
    }
  }
  if (text === "null" || text === "~") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (NUMBER.test(text)) return Number(text);
  return text;
}

const DOC_KEYS = new Set(["name", "exported_at", "entries"]);
const CONTROL_CHARS = /[\u0000-\u001f]/;
const WHITESPACE = /\s/;
const NUL = "\u0000";
const ENTRY_KEYS = new Set(["model", "category", "mean", "weight", "as_of"]);

/**
 * Validates an already-parsed object (a JSON request body, say) as a profile
 * document. `now` stamps entries whose file carries no timestamps.
 */
export function validateProfileDocument(
  raw: unknown,
  source = "<input>",
  now = new Date().toISOString(),
): ProfileDocument {
  if (!isRecord(raw)) throw new Error(`${source}: profile must be a mapping.`);
  rejectUnknown(raw, DOC_KEYS, source, "profile");
  const name = raw.name;
  if (typeof name !== "string" || !name.trim()) {
    throw new Error(`${source}: profile needs a non-empty "name".`);
  }
  if (name.length > 100 || CONTROL_CHARS.test(name)) {
    throw new Error(`${source}: profile "name" must be a short single-line string.`);
  }
  const exportedAt = raw.exported_at ?? now;
  if (typeof exportedAt !== "string" || Number.isNaN(Date.parse(exportedAt))) {
    throw new Error(`${source}: "exported_at" must be an ISO timestamp.`);
  }
  if (!Array.isArray(raw.entries)) {
    throw new Error(`${source}: profile needs an "entries" list.`);
  }
  if (raw.entries.length > MAX_PROFILE_ENTRIES) {
    throw new Error(`${source}: profile has too many entries (max ${MAX_PROFILE_ENTRIES}).`);
  }

  const seen = new Set<string>();
  const entries = raw.entries.map((value, i) => {
    const where = `${source}: entry ${i + 1}`;
    if (!isRecord(value)) throw new Error(`${where} must be a mapping.`);
    rejectUnknown(value, ENTRY_KEYS, where, "entry");
    const model = value.model;
    if (typeof model !== "string" || !model.trim()) {
      throw new Error(`${where} needs a "model".`);
    }
    if (/[:/@]/.test(model)) {
      throw new Error(
        `${where}: "${model}" is not a canonical model id — profiles carry models only, never targets, routes, or instances.`,
      );
    }
    if (model.length > 100 || WHITESPACE.test(model)) {
      throw new Error(`${where}: "model" must be a short identifier without whitespace.`);
    }
    const category = value.category ?? "";
    // NUL separates model from category in the rollup key; letting one
    // through would let a category collide with another model's rows.
    if (typeof category !== "string" || category.includes(NUL) || category.length > 100) {
      throw new Error(`${where}: "category" must be a plain string.`);
    }
    const mean = bounded(value.mean, 1, 5, `${where}: "mean"`);
    // A file that omits weight gets the same weight a fresh seed would; 0 is a
    // deliberate "keep this entry but mute it", never an accident of omission.
    const weight = bounded(
      value.weight ?? DEFAULT_PRIOR_WEIGHT,
      0,
      PRIOR_WEIGHT_CAP,
      `${where}: "weight"`,
    );
    const asOf = value.as_of ?? exportedAt;
    if (typeof asOf !== "string" || Number.isNaN(Date.parse(asOf))) {
      throw new Error(`${where}: "as_of" must be an ISO timestamp.`);
    }
    const key = `${model}${NUL}${category}`;
    if (seen.has(key)) {
      throw new Error(`${where}: duplicate entry for ${model}${category ? ` (${category})` : ""}.`);
    }
    seen.add(key);
    return { model, category, mean, weight, as_of: asOf };
  });

  return { name, exported_at: exportedAt, entries };
}

function bounded(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${what} must be a number between ${min} and ${max}, got ${String(value)}.`);
  }
  return value;
}

function rejectUnknown(
  record: Record<string, unknown>,
  allowed: Set<string>,
  where: string,
  what: string,
): void {
  const unknown = Object.keys(record).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `${where}: unsupported ${what} key(s) ${unknown.join(", ")}. Shared profiles carry canonical priors only.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Plain where it is unambiguous, JSON-quoted otherwise — YAML's double-quoted
 * style takes JSON escapes, so quoting and unquoting are exact inverses. */
export function yamlValue(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value !== "string") return String(value);
  return PLAIN_SAFE.test(value) ? value : JSON.stringify(value);
}

const PLAIN_SAFE = /^[A-Za-z][A-Za-z0-9_.+-]*$/;
