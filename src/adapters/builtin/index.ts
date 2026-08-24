import type { AdapterSpec } from "../types.ts";
import { claudeCodeAdapter } from "./claude-code.ts";
import { codexAdapter } from "./codex.ts";
import { kimiAdapter } from "./kimi.ts";
import { opencodeAdapter } from "./opencode.ts";

/** Pinned, CI-tested adapters (PLAN.md §Agentic discovery). Deterministic order: by app id. */
export const builtinAdapters: AdapterSpec[] = [
  claudeCodeAdapter,
  codexAdapter,
  kimiAdapter,
  opencodeAdapter,
];

export function getAdapter(app: string): AdapterSpec | undefined {
  return builtinAdapters.find((a) => a.app === app);
}

export { claudeCodeAdapter, codexAdapter, kimiAdapter, opencodeAdapter };
