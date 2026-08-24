import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { ensurePaths, resolvePaths } from "./paths.ts";

/**
 * Every case passes an explicit env object — resolvePaths must never be
 * allowed to fall through to the developer's real ~/.config/baton.
 */
function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `baton-${prefix}-`));
}

const perms = (p: string) => statSync(p).mode & 0o777;

describe("resolvePaths — XDG defaults (unscoped)", () => {
  test("splits config and data under the XDG defaults", () => {
    const home = "/home/tester";
    const p = resolvePaths({ HOME: home });

    expect(p.scoped).toBe(false);
    expect(p.configDir).toBe(join(home, ".config", "baton"));
    expect(p.dataDir).toBe(join(home, ".local", "share", "baton"));
    expect(p.dbPath).toBe(join(home, ".local", "share", "baton", "baton.db"));
  });

  test("honours XDG_CONFIG_HOME and XDG_DATA_HOME independently", () => {
    const p = resolvePaths({
      HOME: "/home/tester",
      XDG_CONFIG_HOME: "/cfg",
      XDG_DATA_HOME: "/dat",
    });

    expect(p.configDir).toBe(join("/cfg", "baton"));
    expect(p.dataDir).toBe(join("/dat", "baton"));
    expect(p.dbPath).toBe(join("/dat", "baton", "baton.db"));
    expect(p.scoped).toBe(false);
  });

  test("falls back to os.homedir() when HOME is unset", () => {
    const p = resolvePaths({});
    expect(p.configDir).toBe(join(homedir(), ".config", "baton"));
  });
});

describe("resolvePaths — BATON_CONFIG_DIR relocation", () => {
  test("relocates config AND state under the scope root", () => {
    const root = "/scopes/enterprise";
    const p = resolvePaths({ HOME: "/home/tester", BATON_CONFIG_DIR: root });

    expect(p.scoped).toBe(true);
    expect(p.configDir).toBe(root);
    expect(p.dataDir).toBe(join(root, "state"));
    expect(p.dbPath).toBe(join(root, "state", "baton.db"));
  });

  test("wins over XDG vars — nothing leaks back to the unscoped locations", () => {
    const root = "/scopes/personal";
    const p = resolvePaths({
      HOME: "/home/tester",
      XDG_CONFIG_HOME: "/cfg",
      XDG_DATA_HOME: "/dat",
      BATON_CONFIG_DIR: root,
    });

    for (const dir of [p.configDir, p.dataDir, p.dbPath]) {
      expect(dir.startsWith(root)).toBe(true);
    }
    expect(p.dbPath).not.toContain("/dat");
    expect(p.configDir).not.toContain("/cfg");
  });

  test("empty BATON_CONFIG_DIR is treated as unset", () => {
    const p = resolvePaths({ HOME: "/home/tester", BATON_CONFIG_DIR: "" });
    expect(p.scoped).toBe(false);
    expect(p.configDir).toBe(join("/home/tester", ".config", "baton"));
  });
});

describe("resolvePaths — ~ expansion", () => {
  test("expands a leading ~/", () => {
    const p = resolvePaths({ HOME: "/home/tester", BATON_CONFIG_DIR: "~/scopes/work" });
    expect(p.configDir).toBe("/home/tester/scopes/work");
    expect(p.dbPath).toBe("/home/tester/scopes/work/state/baton.db");
  });

  test("expands a bare ~", () => {
    const p = resolvePaths({ HOME: "/home/tester", BATON_CONFIG_DIR: "~" });
    expect(p.configDir).toBe("/home/tester");
  });

  test("leaves ~user and embedded ~ alone (but still absolutises)", () => {
    expect(resolvePaths({ HOME: "/home/tester", BATON_CONFIG_DIR: "~other/x" }).configDir).toBe(
      join(process.cwd(), "~other/x"),
    );
    expect(resolvePaths({ HOME: "/home/tester", BATON_CONFIG_DIR: "/a/~/b" }).configDir).toBe(
      "/a/~/b",
    );
  });

  test("expands against HOME, not the process's real home", () => {
    const fakeHome = tmp("home");
    const p = resolvePaths({ HOME: fakeHome, BATON_CONFIG_DIR: "~/baton" });
    expect(p.configDir).toBe(join(fakeHome, "baton"));
    expect(p.configDir.startsWith(homedir() + "/")).toBe(false);
  });
});

describe("resolvePaths — relative scope dirs", () => {
  test("absolutises a relative BATON_CONFIG_DIR against cwd", () => {
    const p = resolvePaths({ HOME: "/home/tester", BATON_CONFIG_DIR: "scopes/work" });
    expect(p.configDir).toBe(join(process.cwd(), "scopes", "work"));
    expect(p.dbPath).toBe(join(process.cwd(), "scopes", "work", "state", "baton.db"));
  });

  test("two processes with different cwds resolve the same relative scope identically", () => {
    // Simulated by resolving from an explicit base: the CLI and the MCP server
    // must not end up with different databases for the same BATON_CONFIG_DIR.
    const cwd = process.cwd();
    const a = resolvePaths({ BATON_CONFIG_DIR: "./.baton" });
    const b = resolvePaths({ BATON_CONFIG_DIR: ".baton" });
    expect(a.dbPath).toBe(b.dbPath);
    expect(a.configDir).toBe(join(cwd, ".baton"));
  });

  test("normalises . and .. segments", () => {
    const p = resolvePaths({ BATON_CONFIG_DIR: "/scopes/work/../personal/." });
    expect(p.configDir).toBe("/scopes/personal");
  });
});

describe("ensurePaths", () => {
  test("creates config and data dirs with 0700", () => {
    const root = join(tmp("scope"), "nested", "scope-root");
    const p = ensurePaths(resolvePaths({ BATON_CONFIG_DIR: root }));

    expect(statSync(p.configDir).isDirectory()).toBe(true);
    expect(statSync(p.dataDir).isDirectory()).toBe(true);
    expect(perms(p.configDir)).toBe(0o700);
    expect(perms(p.dataDir)).toBe(0o700);
  });

  test("creates the unscoped split layout too", () => {
    const home = tmp("xdg");
    const p = ensurePaths(resolvePaths({ HOME: home }));

    expect(statSync(p.configDir).isDirectory()).toBe(true);
    expect(statSync(p.dataDir).isDirectory()).toBe(true);
    expect(perms(p.dataDir)).toBe(0o700);
  });

  test("is idempotent and preserves existing contents", () => {
    const root = tmp("idem");
    const p = ensurePaths(resolvePaths({ BATON_CONFIG_DIR: root }));
    const marker = join(p.dataDir, "marker");
    writeFileSync(marker, "keep");

    const again = ensurePaths(resolvePaths({ BATON_CONFIG_DIR: root }));

    expect(again).toEqual(p);
    expect(statSync(marker).isFile()).toBe(true);
    expect(perms(p.dataDir)).toBe(0o700);
  });

  test("tightens a pre-existing world-readable scope dir to 0700", () => {
    // mkdir's mode only applies to dirs it creates, so an existing 0755 dir
    // would otherwise keep leaking prompts to every local user.
    const root = tmp("loose");
    chmodSync(root, 0o755);
    const p = resolvePaths({ BATON_CONFIG_DIR: root });
    mkdirSync(p.dataDir, { recursive: true, mode: 0o755 });
    chmodSync(p.dataDir, 0o755);
    expect(perms(root)).toBe(0o755);

    ensurePaths(p);

    expect(perms(p.configDir)).toBe(0o700);
    expect(perms(p.dataDir)).toBe(0o700);
  });

  test("refuses a path that exists but is not a directory", () => {
    const root = tmp("notdir");
    const file = join(root, "scope");
    writeFileSync(file, "not a dir");
    expect(() => ensurePaths(resolvePaths({ BATON_CONFIG_DIR: file }))).toThrow();
  });

  test("returns the same paths object it was given", () => {
    const p = resolvePaths({ BATON_CONFIG_DIR: tmp("same") });
    expect(ensurePaths(p)).toBe(p);
  });
});
