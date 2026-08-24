import type { AdapterSpec } from "../types.ts";
import { codexAdapter } from "./codex.ts";
import { kimiAdapter } from "./kimi.ts";

/** Pinned, CI-tested adapters (PLAN.md §Agentic discovery). Deterministic order. */
export const builtinAdapters: AdapterSpec[] = [codexAdapter, kimiAdapter];

export function getAdapter(app: string): AdapterSpec | undefined {
  return builtinAdapters.find((a) => a.app === app);
}

export { codexAdapter, kimiAdapter };
