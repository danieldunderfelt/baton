import type { Database } from "bun:sqlite";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { nowIso } from "../store/store.ts";
import { activePriors, activeProfile, effectiveRatings, profileWeight, revision } from "./evalStore.ts";
import { yamlValue } from "./profileFile.ts";
import type { EffectiveRating } from "./types.ts";

/** Ratings are read from SQLite. This file is an optional, on-demand export. */
export const RATINGS_FILE = "ratings.yaml";
export const GENERATED_HEADER = "# Exported by Baton. Run 'baton ratings export' for a fresh snapshot.";

export function ratingsPath(configDir: string): string {
  return join(configDir, RATINGS_FILE);
}

export interface RatingRow extends EffectiveRating {
  priorSource: string | null;
}

export interface RatingsSnapshot {
  revision: number;
  profile: string | null;
  profileWeight: number;
  rows: RatingRow[];
}

/** Read all related tables from one consistent snapshot without taking a write lock. */
export function snapshotRatings(db: Database, now = nowIso()): RatingsSnapshot {
  return db.transaction(() => {
    const sources = new Map(activePriors(db).map((p) => [key(p.model, p.category), p.source]));
    return {
      revision: revision(db),
      profile: activeProfile(db),
      profileWeight: profileWeight(db),
      rows: effectiveRatings(db, now).map((r) => ({
        ...r,
        priorSource: sources.get(key(r.model, r.category)) ?? null,
      })),
    };
  })();
}

/** Explicit exports replace the previous snapshot atomically, including time-dependent decay. */
export function exportRatings(db: Database, configDir: string, now = nowIso()): { path: string; revision: number } {
  const snapshot = snapshotRatings(db, now);
  const path = ratingsPath(configDir);
  const tmp = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    writeFileSync(tmp, renderRatings(snapshot, now), { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  return { path, revision: snapshot.revision };
}

function key(model: string, category: string): string {
  return `${model}\u0000${category}`;
}

export function renderRatings(snapshot: RatingsSnapshot, now = nowIso()): string {
  const lines = [
    `profile: ${yamlValue(snapshot.profile)}`,
    `profile_weight: ${yamlValue(round(snapshot.profileWeight))}`,
    snapshot.rows.length === 0 ? "ratings: []" : "ratings:",
  ];

  for (const row of snapshot.rows) {
    lines.push(`  - model: ${yamlValue(row.model)}`, `    category: ${yamlValue(row.category)}`);
    if (row.observed === null) {
      lines.push("    observed: null");
    } else {
      lines.push(
        "    observed:",
        `      mean: ${yamlValue(round(row.observed))}`,
        `      n_eff: ${yamlValue(round(row.nEff))}`,
      );
    }
    if (row.prior === null) {
      lines.push("    prior: null");
    } else {
      lines.push(
        "    prior:",
        `      mean: ${yamlValue(round(row.prior))}`,
        `      weight: ${yamlValue(round(row.priorWeight))}`,
        `      source: ${yamlValue(row.priorSource)}`,
      );
    }
    lines.push(`    blended: ${yamlValue(row.blended === null ? null : round(row.blended))}`);
  }

  const body = `\n${lines.join("\n")}\n`;
  const header = [
    GENERATED_HEADER,
    `# source_revision: ${snapshot.revision}`,
    `# generated_at: ${now}`,
    "#",
    "# observed: your own graded runs, decayed (n_eff = how many observations they are worth)",
    "# prior:    the active profile's seeded or imported opinion, decayed from its own as_of",
    "# blended:  the two combined — what selection ranks on",
    '# category "" is the uncategorised default: work graded without a category.',
  ];
  return `${header.join("\n")}\n${body}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
