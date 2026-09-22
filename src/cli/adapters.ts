import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { builtinAdapters, getAdapter } from "../adapters/builtin/index.ts";
import { getDiscovered, listDiscovered, submitSpec, validateSpec } from "../discovery/discovery.ts";
import { setAdapterEnabled, testAdapter } from "../discovery/diagnostics.ts";
import { printable } from "../discovery/types.ts";
import { listBlocks } from "../registry/blocks.ts";

export async function runAdapters(db: Database, args: string[]): Promise<number> {
  const [command = "list", value, ...rest] = args;
  switch (command) {
    case "list": {
      console.log("APP\tPROVENANCE\tSTATUS\tBINARY");
      for (const spec of builtinAdapters) {
        const disabled = listBlocks(db).some((block) => block.pattern === `${spec.app}:*/*`);
        console.log(
          [spec.app, "built-in", disabled ? "disabled" : "enabled", spec.binary]
            .map(printable)
            .join("\t"),
        );
      }
      for (const record of listDiscovered(db)) {
        console.log(
          [record.app, "registered", record.status, record.spec.binary].map(printable).join("\t"),
        );
      }
      return 0;
    }
    case "add": {
      if (!value || rest.length) throw new Error("Usage: baton adapters add <spec.json>");
      const raw: unknown = JSON.parse(readFileSync(value, "utf8"));
      const stored = submitSpec(db, raw);
      if (!stored.ok) throw new Error(`Invalid adapter:\n- ${stored.errors.join("\n- ")}`);
      console.log(
        `${stored.record.app}: ${stored.record.status}${stored.changed ? "" : " (unchanged)"}`,
      );
      return 0;
    }
    case "show": {
      if (!value || rest.length) throw new Error("Usage: baton adapters show <app>");
      const spec = getAdapter(value) ?? getDiscovered(db, value)?.spec;
      if (!spec) throw new Error(`Unknown adapter '${value}'.`);
      console.log(JSON.stringify(spec, null, 2));
      return 0;
    }
    case "enable":
    case "disable": {
      if (!value || rest.length) throw new Error(`Usage: baton adapters ${command} <app>`);
      setAdapterEnabled(db, value, command === "enable");
      console.log(`${value}: ${command === "enable" ? "enabled" : "disabled"}`);
      return 0;
    }
    case "test": {
      if (!value || rest.some((arg) => arg !== "--structural"))
        throw new Error("Usage: baton adapters test <app|--all> [--structural]");
      const registered = listDiscovered(db);
      const disabled = new Set(
        registered.filter((record) => record.status === "disabled").map((record) => record.app),
      );
      const specs = [...builtinAdapters, ...registered.map((record) => record.spec)];
      const selected = value === "--all" ? specs : specs.filter((spec) => spec.app === value);
      if (!selected.length) throw new Error(`Unknown adapter '${value}'.`);
      let failures = 0;
      for (const spec of selected) {
        if (value === "--all" && !rest.includes("--structural") && disabled.has(spec.app)) {
          console.log(`${spec.app}: skipped (disabled)`);
          continue;
        }
        const validation = validateSpec(spec, { builtin: !!getAdapter(spec.app) });
        if (!validation.ok) {
          console.error(`${spec.app}: ${validation.errors.join("; ")}`);
          failures++;
        } else if (rest.includes("--structural")) console.log(`${spec.app}: valid`);
        else {
          try {
            const result = await testAdapter(db, spec.app);
            console.log(`${result.app}: ${result.detail}`);
            if (!result.passed) failures++;
          } catch (error) {
            console.error(`${spec.app}: ${error instanceof Error ? error.message : String(error)}`);
            failures++;
          }
        }
      }
      return failures ? 1 : 0;
    }
    default:
      throw new Error("Usage: baton adapters <list|add|show|enable|disable|test>");
  }
}
