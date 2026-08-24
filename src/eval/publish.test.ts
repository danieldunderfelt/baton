import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensurePaths, resolvePaths } from "../config/paths.ts";
import { newId, openStore } from "../store/store.ts";
import { recordGrade, revision, seedPriors, setActiveProfile } from "./evalStore.ts";
import {
  GENERATED_HEADER,
  NO_REVISION,
  commitRender,
  fileRevision,
  parseSourceRevision,
  projectionIntact,
  publishRatings,
  ratingsPath,
  renderRatings,
  repairProjection,
  snapshotRatings,
} from "./publish.ts";

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
    const result = publishRatings(db, configDir, NOW);

    expect(result.published).toBe(true);
    expect(result.revision).toBe(revision(db));
    const text = read(configDir);
    expect(text.startsWith(GENERATED_HEADER)).toBe(true);
    expect(text).toContain("seed_ratings");
    expect(parseSourceRevision(text)).toBe(result.revision);
    expect(fileRevision(configDir)).toBe(result.revision);
    expect(text).toContain(`# generated_at: ${NOW}`);
    // The header also checksums the body, so a corrupted file is detectable.
    expect(text).toMatch(/^# digest: [0-9a-f]{64}$/m);
    expect(projectionIntact(configDir)).toBe(true);
  });

  test("keeps observed, prior and blended visibly separate", () => {
    const { db, configDir } = scope("pub-provenance");
    seedPriors(db, "mine", [{ model: "kimi-k3", mean: 3, weight: 4 }], NOW);
    grade(db, { grade: 5 });
    publishRatings(db, configDir, NOW);

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
    publishRatings(db, configDir, NOW);

    const text = read(configDir);
    expect(text).toContain("  - model: opus-5");
    expect(text).toContain("    observed: null");
    expect(text).toContain("      source: seeded");
  });

  test("names the active profile and its weight, and says so when there is none", () => {
    const { db, configDir } = scope("pub-profile");
    publishRatings(db, configDir, NOW);
    expect(read(configDir)).toContain("profile: null");
    expect(read(configDir)).toContain("ratings: []");

    seedPriors(db, "team alpha", [{ model: "kimi-k3", mean: 4 }], NOW);
    db.query("INSERT INTO settings (key, value) VALUES ('profile_weight', '0.5')").run();
    setActiveProfile(db, "team alpha");
    publishRatings(db, configDir, NOW);

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
    publishRatings(db, configDir, NOW);

    const text = read(configDir);
    expect(text.indexOf("category: implementation")).toBeLessThan(text.indexOf("category: review"));
    expect(text).toContain("      mean: 5");
    expect(text).toContain("      mean: 2");
  });
});

describe("publication protocol", () => {
  test("stamps the publication lock row it takes", () => {
    const { db, configDir } = scope("pub-lock");
    publishRatings(db, configDir, NOW);
    const row = db
      .query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'ratings_published_at'")
      .get();
    expect(row?.value).toBe(NOW);
  });

  test("discards a render older than what is already on disk", () => {
    const { db, configDir } = scope("pub-stale");
    grade(db);
    grade(db);
    const current = publishRatings(db, configDir, NOW);
    const fresh = read(configDir);

    // A render computed before the last two commits landing: it must not win.
    const behind = { ...snapshotRatings(db, NOW), revision: current.revision - 1 };
    const stale = renderRatings(behind, NOW);
    expect(commitRender(configDir, stale, current.revision - 1)).toBe(false);
    expect(read(configDir)).toBe(fresh);
  });

  test("does not rewrite the file for the same revision", () => {
    const { db, configDir } = scope("pub-noop");
    grade(db);
    const first = publishRatings(db, configDir, NOW);
    const again = publishRatings(db, configDir, "2026-02-02T00:00:00.000Z");

    expect(again.published).toBe(false);
    expect(again.revision).toBe(first.revision);
    // Untouched, generation time included.
    expect(read(configDir)).toContain(`# generated_at: ${NOW}`);
  });

  test("publishes again once a new outcome bumps the revision", () => {
    const { db, configDir } = scope("pub-advance");
    grade(db, { grade: 2 });
    publishRatings(db, configDir, NOW);
    expect(read(configDir)).toContain("      mean: 2");

    const rev = grade(db, { grade: 4 });
    const result = publishRatings(db, configDir, NOW);
    expect(result).toMatchObject({ published: true, revision: rev });
    expect(fileRevision(configDir)).toBe(rev);
    expect(read(configDir)).toContain("      mean: 3");
  });

  test("leaves no temp file behind, on success or on a failed rename", () => {
    const { db, configDir } = scope("pub-atomic");
    grade(db);
    publishRatings(db, configDir, NOW);
    expect(tmpFiles(configDir)).toEqual([]);

    const blocked = mkdtempSync(join(tmpdir(), "baton-pub-blocked-"));
    mkdirSync(ratingsPath(blocked));
    expect(() => commitRender(blocked, "whatever", 1)).toThrow();
    expect(tmpFiles(blocked)).toEqual([]);
  });
});

describe("header parsing", () => {
  test("round-trips its own render", () => {
    const { db } = scope("pub-parse");
    grade(db);
    const snapshot = snapshotRatings(db, NOW);
    expect(parseSourceRevision(renderRatings(snapshot, NOW))).toBe(snapshot.revision);
  });

  test("treats a missing, hand-edited or body-only revision as older than everything", () => {
    const { configDir } = scope("pub-parse-missing");
    expect(fileRevision(configDir)).toBe(NO_REVISION);

    writeFileSync(ratingsPath(configDir), "# hand written\nprofile: mine\n# source_revision: 9\n");
    // Past the header block: not a source of truth.
    expect(fileRevision(configDir)).toBe(NO_REVISION);

    writeFileSync(ratingsPath(configDir), "# source_revision: not-a-number\nratings: []\n");
    expect(fileRevision(configDir)).toBe(NO_REVISION);
  });
});

describe("startup repair", () => {
  test("writes the projection when the file is missing", () => {
    const { db, configDir } = scope("repair-missing");
    const rev = grade(db);
    expect(repairProjection(db, configDir, NOW)).toMatchObject({ published: true, revision: rev });
    expect(fileRevision(configDir)).toBe(rev);
  });

  test("replaces a stale projection left by a crashed publisher", () => {
    const { db, configDir } = scope("repair-stale");
    grade(db);
    publishRatings(db, configDir, NOW);
    const rev = grade(db, { grade: 1 });

    expect(repairProjection(db, configDir, NOW).published).toBe(true);
    expect(fileRevision(configDir)).toBe(rev);
  });

  test("does nothing when the projection already matches", () => {
    const { db, configDir } = scope("repair-current");
    grade(db);
    publishRatings(db, configDir, NOW);
    const before = read(configDir);

    expect(repairProjection(db, configDir, "2026-03-03T00:00:00.000Z").published).toBe(false);
    expect(read(configDir)).toBe(before);
  });

  test("repairs a corrupted body whose header still claims the current revision", () => {
    const { db, configDir } = scope("repair-corrupt");
    const rev = grade(db, { grade: 5 });
    publishRatings(db, configDir, NOW);
    const good = read(configDir);
    expect(projectionIntact(configDir)).toBe(true);

    // Truncated mid-write, or hand-edited: the header is intact and still says
    // the current revision, so the older-only rule alone would never fix it.
    writeFileSync(ratingsPath(configDir), good.replace("      mean: 5", "      mean: 1"));
    expect(fileRevision(configDir)).toBe(rev);
    expect(projectionIntact(configDir)).toBe(false);

    expect(repairProjection(db, configDir, NOW).published).toBe(true);
    expect(read(configDir)).toBe(good);
    expect(projectionIntact(configDir)).toBe(true);
  });

  test("re-renders a projection that carries no digest at all", () => {
    const { db, configDir } = scope("repair-nodigest");
    const rev = grade(db);
    // What an older Baton left behind: right revision, no checksum to trust.
    writeFileSync(ratingsPath(configDir), `# source_revision: ${rev}\nratings: []\n`);

    expect(repairProjection(db, configDir, NOW).published).toBe(true);
    expect(projectionIntact(configDir)).toBe(true);
  });

  test("replaces a projection that is ahead of the store", () => {
    const { db, configDir } = scope("repair-ahead");
    const rev = grade(db);
    // A config dir copied from elsewhere, or a restored database.
    writeFileSync(ratingsPath(configDir), "# source_revision: 9999\nratings: []\n");

    expect(repairProjection(db, configDir, NOW).published).toBe(true);
    expect(fileRevision(configDir)).toBe(rev);
  });
});
