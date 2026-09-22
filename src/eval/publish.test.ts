import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensurePaths, resolvePaths } from "../config/paths.ts";
import { newId, openStore } from "../store/store.ts";
import { recordGrade, revision, seedPriors, setActiveProfile } from "./evalStore.ts";
import { GENERATED_HEADER, exportRatings, ratingsPath, snapshotRatings } from "./publish.ts";

/** A throwaway BATON_CONFIG_DIR scope. Never touches real Baton state. */
function scope(name: string): { db: Database; configDir: string } {
  const root = mkdtempSync(join(tmpdir(), `baton-${name}-`));
  const paths = ensurePaths(resolvePaths({ BATON_CONFIG_DIR: root }));
  return { db: openStore(paths.dbPath), configDir: paths.configDir };
}

const NOW = "2026-01-01T00:00:00.000Z";
const KIMI = "kimi:default/kimi-code/k3@a1+full";

function grade(db: Database, o: { grade?: number; model?: string; category?: string } = {}): number {
  const runId = newId("run");
  db.query(
    `INSERT INTO runs (id, model, app, slug, prompt, cwd, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, "kimi-k3", "kimi", "kimi-code/k3", "hi", "/tmp", "succeeded", NOW, NOW);
  return recordGrade(db, {
    runId,
    grade: o.grade ?? 4,
    target: KIMI,
    model: o.model ?? "kimi-k3",
    ...(o.category === undefined ? {} : { category: o.category }),
    runAt: NOW,
    gradedAt: NOW,
  });
}

const read = (configDir: string) => readFileSync(ratingsPath(configDir), "utf8");
const tmpFiles = (configDir: string) =>
  readdirSync(configDir).filter((f) => f.includes("ratings.yaml.tmp"));

describe("rendering", () => {
  test("carries the generated header and the revision it was rendered from", () => {
    const { db, configDir } = scope("pub-header");
    grade(db);
    const result = exportRatings(db, configDir, NOW);

    expect(result.revision).toBe(revision(db));
    const text = read(configDir);
    expect(text.startsWith(GENERATED_HEADER)).toBe(true);
    expect(text).toContain(`# source_revision: ${result.revision}`);
    expect(text).toContain(`# generated_at: ${NOW}`);
    expect(text).not.toContain("# digest:");
  });

  test("keeps observed, prior and blended visibly separate", () => {
    const { db, configDir } = scope("pub-provenance");
    seedPriors(db, "mine", [{ model: "kimi-k3", mean: 3, weight: 4 }], NOW);
    grade(db, { grade: 5 });
    exportRatings(db, configDir, NOW);

    expect(read(configDir)).toContain(
      [
        "  - model: kimi-k3",
        '    category: ""',
        "    observed:",
        "      mean: 5",
        "      n_eff: 1",
        "    prior:",
        "      mean: 3",
        "      weight: 4",
        "      source: seeded",
        "    blended: 3.4",
      ].join("\n"),
    );
  });

  test("shows a seeded-but-ungraded model as observed: null, not as a number", () => {
    const { db, configDir } = scope("pub-unrated");
    seedPriors(db, "mine", [{ model: "opus-5", mean: 4.5 }], NOW);
    exportRatings(db, configDir, NOW);

    const text = read(configDir);
    expect(text).toContain("  - model: opus-5");
    expect(text).toContain("    observed: null");
    expect(text).toContain("      source: seeded");
  });

  test("names the active profile and its weight, and says so when there is none", () => {
    const { db, configDir } = scope("pub-profile");
    exportRatings(db, configDir, NOW);
    expect(read(configDir)).toContain("profile: null");
    expect(read(configDir)).toContain("ratings: []");

    seedPriors(db, "team alpha", [{ model: "kimi-k3", mean: 4 }], NOW);
    db.query("INSERT INTO settings (key, value) VALUES ('profile_weight', '0.5')").run();
    setActiveProfile(db, "team alpha");
    exportRatings(db, configDir, NOW);

    const text = read(configDir);
    expect(text).toContain('profile: "team alpha"');
    expect(text).toContain("profile_weight: 0.5");
    // The prior weight shown is the one that actually blended.
    expect(text).toContain("      weight: 2.5");
  });

  test("renders categories separately under the same model", () => {
    const { db, configDir } = scope("pub-categories");
    grade(db, { category: "implementation", grade: 5 });
    grade(db, { category: "review", grade: 2 });
    exportRatings(db, configDir, NOW);

    const text = read(configDir);
    expect(text.indexOf("category: implementation")).toBeLessThan(text.indexOf("category: review"));
    expect(text).toContain("      mean: 5");
    expect(text).toContain("      mean: 2");
  });
});

describe("on-demand export", () => {
  test("reading and grading never write an export or a publication lock", () => {
    const { db, configDir } = scope("export-only");
    grade(db);
    snapshotRatings(db);
    expect(existsSync(ratingsPath(configDir))).toBe(false);
    exportRatings(db, configDir, NOW);
    expect(db.query("SELECT 1 FROM settings WHERE key = 'ratings_published_at'").get()).toBeNull();
  });

  test("a fresh export includes decay even without a new revision", () => {
    const { db, configDir } = scope("export-decay");
    grade(db);
    const first = exportRatings(db, configDir, NOW);
    const before = read(configDir);
    const second = exportRatings(db, configDir, "2026-02-01T00:00:00.000Z");
    expect(second.revision).toBe(first.revision);
    expect(read(configDir)).not.toBe(before);
    expect(read(configDir)).toContain("generated_at: 2026-02-01");
  });

  test("replaces an older snapshot and leaves no partial file on failure", () => {
    const { db, configDir } = scope("export-atomic");
    writeFileSync(ratingsPath(configDir), "old snapshot");
    exportRatings(db, configDir, NOW);
    expect(read(configDir)).toContain("ratings: []");
    expect(statSync(ratingsPath(configDir)).mode & 0o777).toBe(0o600);
    expect(tmpFiles(configDir)).toEqual([]);
    const blocked = mkdtempSync(join(tmpdir(), "baton-export-blocked-"));
    mkdirSync(ratingsPath(blocked));
    expect(() => exportRatings(db, blocked)).toThrow();
    expect(tmpFiles(blocked)).toEqual([]);
  });
});
