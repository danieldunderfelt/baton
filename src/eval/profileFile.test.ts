import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensurePaths, resolvePaths } from "../config/paths.ts";
import { newId, openStore } from "../store/store.ts";
import {
  DEFAULT_PRIOR_WEIGHT,
  activePriors,
  activeProfile,
  recordGrade,
  revision,
  seedPriors,
} from "./evalStore.ts";
import {
  diffProfileDocument,
  exportProfile,
  importProfileDocument,
  importProfileFile,
  parseProfileDocument,
  renderProfile,
  type ProfileDocument,
} from "./profileFile.ts";
import { PRIOR_WEIGHT_CAP } from "./types.ts";

/** A throwaway BATON_CONFIG_DIR scope. Never touches real Baton state. */
function scope(name: string): { db: Database; configDir: string } {
  const root = mkdtempSync(join(tmpdir(), `baton-${name}-`));
  const paths = ensurePaths(resolvePaths({ BATON_CONFIG_DIR: root }));
  return { db: openStore(paths.dbPath), configDir: paths.configDir };
}

const NOW = "2026-01-01T00:00:00.000Z";

function writeDoc(configDir: string, text: string, name = "profile.yaml"): string {
  const path = join(configDir, name);
  writeFileSync(path, text);
  return path;
}

/** Exports `profile` from `db` to a file the importer can read. */
function exportToFile(db: Database, configDir: string, profile: string): string {
  return writeDoc(configDir, renderProfile(exportProfile(db, profile, NOW)));
}

describe("export", () => {
  test("emits canonical priors only — no targets, instances or machine details", () => {
    const { db, configDir } = scope("prof-export");
    seedPriors(
      db,
      "mine",
      [
        { model: "opus-5", mean: 4, weight: 5 },
        { model: "kimi-k3", category: "implementation", mean: 4.5, weight: 3 },
      ],
      NOW,
    );
    const runId = newId("run");
    db.query(
      `INSERT INTO runs (id, model, app, slug, prompt, cwd, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      "kimi-k3",
      "kimi",
      "kimi-code/k3",
      "secret prompt",
      "/private/work",
      "succeeded",
      NOW,
      NOW,
    );
    recordGrade(db, {
      runId,
      grade: 5,
      target: "kimi:work/kimi-code/k3@a1+full",
      model: "kimi-k3",
      runAt: NOW,
      gradedAt: NOW,
    });

    const doc = exportProfile(db, "mine", NOW);
    expect(doc).toEqual({
      name: "mine",
      exported_at: NOW,
      entries: [
        { model: "kimi-k3", category: "implementation", mean: 4.5, weight: 3, as_of: NOW },
        { model: "opus-5", category: "", mean: 4, weight: 5, as_of: NOW },
      ],
    });

    const text = renderProfile(doc);
    expect(text).not.toContain("kimi:work");
    expect(text).not.toContain("secret prompt");
    expect(text).not.toContain("/private/work");
    expect(text).toContain("# Baton profile");
  });

  test("refuses to export a profile that does not exist", () => {
    const { db } = scope("prof-export-empty");
    expect(() => exportProfile(db, "nope", NOW)).toThrow(/no priors to export/);
  });
});

describe("round trip", () => {
  test("export → import reproduces the priors in another scope", () => {
    const source = scope("prof-source");
    seedPriors(
      source.db,
      "mine",
      [
        { model: "opus-5", mean: 4, weight: 5 },
        { model: "kimi-k3", category: "implementation", mean: 4.5, weight: 3 },
      ],
      NOW,
    );
    const path = exportToFile(source.db, source.configDir, "mine");

    const target = scope("prof-target");
    const diff = importProfileFile(target.db, path, {}, NOW);

    expect(diff.profile).toBe("mine");
    expect(diff.source).toBe("mine");
    expect(diff.added).toEqual([
      { model: "kimi-k3", category: "implementation", mean: 4.5, weight: 3 },
      { model: "opus-5", category: "", mean: 4, weight: 5 },
    ]);
    expect(activePriors(target.db)).toEqual([]);
    expect(
      target.db
        .query<{ source: string }, []>("SELECT DISTINCT source FROM priors")
        .all()
        .map((r) => r.source),
    ).toEqual(["imported:mine"]);
  });

  test("accepts its own document as JSON too", () => {
    const { db, configDir } = scope("prof-json");
    seedPriors(db, "mine", [{ model: "opus-5", mean: 4 }], NOW);
    const doc = exportProfile(db, "mine", NOW);

    const other = scope("prof-json-target");
    const path = writeDoc(other.configDir, JSON.stringify(doc, null, 2), "profile.json");
    expect(importProfileFile(other.db, path, {}, NOW).added).toHaveLength(1);
  });

  test("quotes and unquotes values that YAML would otherwise mangle", () => {
    const doc: ProfileDocument = {
      name: "team: alpha",
      exported_at: NOW,
      entries: [{ model: "gpt-5.6-sol", category: "code review", mean: 4, weight: 5, as_of: NOW }],
    };
    expect(parseProfileDocument(renderProfile(doc))).toEqual(doc);
  });
});

describe("import diff", () => {
  test("reports added, changed and unchanged without silently reweighting", () => {
    const { db, configDir } = scope("prof-diff");
    seedPriors(
      db,
      "shared",
      [
        { model: "opus-5", mean: 4, weight: 5 },
        { model: "kimi-k3", mean: 3, weight: 5 },
      ],
      NOW,
    );
    const path = writeDoc(
      configDir,
      renderProfile({
        name: "shared",
        exported_at: NOW,
        entries: [
          { model: "opus-5", category: "", mean: 4, weight: 5, as_of: NOW },
          { model: "kimi-k3", category: "", mean: 4.5, weight: 2, as_of: NOW },
          { model: "gpt-5.6-sol", category: "", mean: 4, weight: 5, as_of: NOW },
        ],
      }),
    );

    const diff = importProfileFile(db, path, {}, NOW);
    // opus-5's numbers match, but the import relabels a seeded prior as an
    // imported one — same numbers, different provenance, so not "unchanged".
    expect(diff.unchanged).toEqual([]);
    expect(diff.changed).toEqual([
      {
        model: "opus-5",
        category: "",
        mean: 4,
        weight: 5,
        previous: { mean: 4, weight: 5, source: "seeded", asOf: NOW },
      },
      {
        model: "kimi-k3",
        category: "",
        mean: 4.5,
        weight: 2,
        previous: { mean: 3, weight: 5, source: "seeded", asOf: NOW },
      },
    ]);
    expect(diff.added).toEqual([{ model: "gpt-5.6-sol", category: "", mean: 4, weight: 5 }]);
    expect(diff.revision).toBe(revision(db));
  });

  test("re-importing the same document twice really is a no-op", () => {
    const { db, configDir } = scope("prof-diff-idempotent");
    const path = writeDoc(
      configDir,
      renderProfile({
        name: "shared",
        exported_at: NOW,
        entries: [{ model: "opus-5", category: "", mean: 4, weight: 5, as_of: NOW }],
      }),
    );

    expect(importProfileFile(db, path, {}, NOW).added).toHaveLength(1);
    const again = importProfileFile(db, path, {}, "2026-06-01T00:00:00.000Z");
    expect(again.changed).toEqual([]);
    expect(again.unchanged).toEqual([{ model: "opus-5", category: "", mean: 4, weight: 5 }]);
  });

  test("a re-export with a fresher as_of is reported as a change, not as unchanged", () => {
    const { db, configDir } = scope("prof-diff-as-of");
    const LAST_YEAR = "2025-01-01T00:00:00.000Z";
    const entry = { model: "opus-5", category: "", mean: 4, weight: 8 };
    writeDoc(
      configDir,
      renderProfile({ name: "shared", exported_at: LAST_YEAR, entries: [{ ...entry, as_of: LAST_YEAR }] }),
      "old.yaml",
    );
    const fresh = writeDoc(
      configDir,
      renderProfile({ name: "shared", exported_at: NOW, entries: [{ ...entry, as_of: NOW }] }),
      "new.yaml",
    );
    importProfileFile(db, join(configDir, "old.yaml"), {}, NOW);

    // Identical mean and weight, a year newer: the prior's precision is restored
    // from near-nothing to the full 8, which the diff has to say out loud.
    const diff = importProfileFile(db, fresh, {}, NOW);
    expect(diff.unchanged).toEqual([]);
    expect(diff.changed[0]!.previous).toEqual({
      mean: 4,
      weight: 8,
      source: "imported:shared",
      asOf: LAST_YEAR,
    });
  });

  test("the dry run previews exactly what the commit then writes", () => {
    const { db, configDir } = scope("prof-diff-preview");
    const LAST_YEAR = "2025-01-01T00:00:00.000Z";
    seedPriors(db, "shared", [{ model: "opus-5", mean: 4, weight: 5 }], LAST_YEAR);
    const doc: ProfileDocument = {
      name: "shared",
      exported_at: NOW,
      entries: [
        // Same mean and weight as the seeded row: only as_of and provenance
        // move. A preview that compares neither calls this unchanged and then
        // changes it anyway — the confirmation would be a lie.
        { model: "opus-5", category: "", mean: 4, weight: 5, as_of: NOW },
        { model: "kimi-k3", category: "", mean: 3, weight: 2, as_of: NOW },
      ],
    };
    const path = writeDoc(configDir, renderProfile(doc));

    const preview = diffProfileDocument(db, doc, "shared", NOW);
    expect(preview.changed).toEqual([
      {
        model: "opus-5",
        category: "",
        mean: 4,
        weight: 5,
        previous: { mean: 4, weight: 5, source: "seeded", asOf: LAST_YEAR },
      },
    ]);
    expect(preview.unchanged).toEqual([]);

    // The commit agrees, field for field, and the preview wrote nothing.
    const committed = importProfileFile(db, path, {}, NOW);
    expect(committed.changed).toEqual(preview.changed);
    expect(committed.added).toEqual(preview.added);
    expect(committed.unchanged).toEqual(preview.unchanged);
  });

  test("stores under a local name while keeping the document's provenance", () => {
    const source = scope("prof-rename-source");
    seedPriors(source.db, "alice", [{ model: "opus-5", mean: 4 }], NOW);
    const path = exportToFile(source.db, source.configDir, "alice");

    const { db } = scope("prof-rename");
    const diff = importProfileFile(db, path, { name: "from-alice" }, NOW);

    expect(diff.profile).toBe("from-alice");
    expect(
      db.query<{ profile: string; source: string }, []>("SELECT profile, source FROM priors").all(),
    ).toEqual([{ profile: "from-alice", source: "imported:alice" }]);
  });
});

describe("as_of provenance", () => {
  test("each entry keeps the age it was exported with, not the import time", () => {
    const source = scope("prof-as-of-source");
    const LAST_YEAR = "2025-01-01T00:00:00.000Z";
    seedPriors(source.db, "alice", [{ model: "opus-5", mean: 4 }], LAST_YEAR);
    const path = exportToFile(source.db, source.configDir, "alice");

    const { db } = scope("prof-as-of");
    importProfileFile(db, path, { activate: true }, NOW);
    // A year-old opinion must not arrive looking freshly formed.
    expect(activePriors(db)[0]!.asOf).toBe(LAST_YEAR);
  });
});

describe("activation", () => {
  test("never activates by default", () => {
    const source = scope("prof-act-source");
    seedPriors(source.db, "alice", [{ model: "opus-5", mean: 4 }], NOW);
    const path = exportToFile(source.db, source.configDir, "alice");

    const { db } = scope("prof-act-off");
    importProfileFile(db, path, {}, NOW);
    expect(activeProfile(db)).toBeNull();
  });

  test("activates only when explicitly asked, and reports the resulting revision", () => {
    const source = scope("prof-act-source2");
    seedPriors(source.db, "alice", [{ model: "opus-5", mean: 4 }], NOW);
    const path = exportToFile(source.db, source.configDir, "alice");

    const { db } = scope("prof-act-on");
    seedPriors(db, "mine", [{ model: "kimi-k3", mean: 3 }], NOW);
    const diff = importProfileFile(db, path, { activate: true }, NOW);

    expect(activeProfile(db)).toBe("alice");
    expect(diff.revision).toBe(revision(db));
    // Switching the prior does not touch the profile that was active before.
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM priors WHERE profile = 'mine'").get()
        ?.n,
    ).toBe(1);
  });
});

describe("validation", () => {
  const parse = (text: string) => () => parseProfileDocument(text, "p.yaml");

  test("rejects a file that is not a profile at all", () => {
    expect(parse("")).toThrow(/empty/);
    expect(parse("just some prose\n")).toThrow(/line 1/);
    expect(parse("{ not json\n")).toThrow(/not valid JSON/);
    expect(parse("name: mine\n")).toThrow(/"entries" list/);
    expect(parse("entries:\n  - model: opus-5\n    mean: 4\n")).toThrow(/non-empty "name"/);
  });

  test("rejects anything outside the portable format", () => {
    expect(
      parse('name: mine\nentries:\n  - model: opus-5\n    mean: 4\n    target: "kimi:work/k3"\n'),
    ).toThrow(/unsupported entry key\(s\) target/);
    expect(parse("name: mine\ninstance: personal-2\nentries: []\n")).toThrow(
      /unsupported profile key\(s\) instance/,
    );
    expect(parse('name: mine\nentries:\n  - model: "kimi:work/kimi-code/k3"\n    mean: 4\n')).toThrow(
      /not a canonical model id/,
    );
  });

  test("enforces the grade scale and the prior weight cap", () => {
    const entry = (fields: string) => `name: mine\nentries:\n  - model: opus-5\n${fields}`;
    expect(parse(entry("    mean: 6\n"))).toThrow(/"mean" must be a number between 1 and 5/);
    expect(parse(entry("    mean: 0\n"))).toThrow(/"mean" must be a number between 1 and 5/);
    expect(parse(entry('    mean: "four"\n'))).toThrow(/"mean" must be a number/);
    expect(parse(entry("    mean: 4\n    weight: -1\n"))).toThrow(/"weight" must be a number/);
    expect(parse(entry(`    mean: 4\n    weight: ${PRIOR_WEIGHT_CAP + 1}\n`))).toThrow(
      new RegExp(`between 0 and ${PRIOR_WEIGHT_CAP}`),
    );
    expect(parse(entry("    mean: 4\n    as_of: yesterday\n"))).toThrow(/ISO timestamp/);
  });

  test("rejects structurally broken YAML with the offending line", () => {
    expect(parse("name: mine\n  - model: opus-5\n")).toThrow(/line 2: indented line outside/);
    expect(parse("name: mine\nentries:\n    mean: 4\n")).toThrow(/line 3: entry field before/);
    expect(parse("name mine\n")).toThrow(/line 1: expected `key: value`/);
    expect(parse("name: mine\nentries: 3\n")).toThrow(/`entries:` must be a list/);
    expect(
      parse("name: mine\nentries:\n  - model: opus-5\n    mean: 4\n  - model: opus-5\n    mean: 5\n"),
    ).toThrow(/duplicate entry for opus-5/);
  });

  test("leaves the store untouched when the file is rejected", () => {
    const { db, configDir } = scope("prof-reject");
    const path = writeDoc(configDir, "name: mine\nentries:\n  - model: opus-5\n    mean: 9\n");

    expect(() => importProfileFile(db, path, {}, NOW)).toThrow(/between 1 and 5/);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM priors").get()?.n).toBe(0);
    expect(revision(db)).toBe(0);
  });

  test("says which file it could not read", () => {
    const { db, configDir } = scope("prof-missing");
    expect(() => importProfileFile(db, join(configDir, "nope.yaml"), {}, NOW)).toThrow(
      /Cannot read profile file .*nope\.yaml/,
    );
  });

  test("empty list and comments are legal", () => {
    expect(parseProfileDocument("# a note\nname: mine\nentries: []\n").entries).toEqual([]);
  });

  test("fills in the defaults the format allows omitting", () => {
    const doc = parseProfileDocument(
      `name: mine\nexported_at: ${NOW}\nentries:\n  - model: opus-5\n    mean: 4\n`,
    );
    expect(doc.entries[0]).toEqual({
      model: "opus-5",
      category: "",
      mean: 4,
      weight: DEFAULT_PRIOR_WEIGHT,
      as_of: NOW,
    });
  });
});

describe("replace", () => {
  test("a refreshed document removes priors it no longer names, and the preview says so", () => {
    const target = scope("prof-replace");
    seedPriors(
      target.db,
      "alice/picks",
      [
        { model: "opus-5", mean: 4, weight: 5 },
        { model: "kimi-k3", category: "implementation", mean: 4.5, weight: 3 },
      ],
      NOW,
    );
    const refreshed: ProfileDocument = {
      name: "picks",
      exported_at: NOW,
      entries: [{ model: "opus-5", category: "", mean: 4, weight: 5, as_of: NOW }],
    };

    const preview = diffProfileDocument(target.db, refreshed, "alice/picks", NOW, "alice/picks", true);
    expect(preview.removed).toEqual([{ model: "kimi-k3", category: "implementation", mean: 4.5, weight: 3 }]);
    // Without replace, the stale prior is invisible — the old behaviour, kept for seeds.
    expect(diffProfileDocument(target.db, refreshed, "alice/picks", NOW, "alice/picks").removed).toEqual([]);

    const committed = importProfileDocument(target.db, refreshed, {
      name: "alice/picks",
      source: "alice/picks",
      replace: true,
    });
    expect(committed.removed).toEqual(preview.removed);
    const left = target.db
      .query<{ model: string }, [string]>("SELECT model FROM priors WHERE profile = ? ORDER BY model")
      .all("alice/picks")
      .map((r) => r.model);
    expect(left).toEqual(["opus-5"]);
  });
});
