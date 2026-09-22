import { z } from "zod";

const autonomySchema = z.enum(["readonly", "edits", "full"]);
export type Autonomy = z.infer<typeof autonomySchema>;
export const AUTONOMY_ORDER: Autonomy[] = autonomySchema.options;

const dotPath = z.string().min(1).describe("Dot-path; numeric segments index arrays.");
const match = z.strictObject({ path: dotPath, equals: z.string() });

export const extractSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("text") }).describe("Whole stdout, trimmed."),
    z.strictObject({ kind: z.literal("json"), path: dotPath }),
    z.strictObject({
      kind: z.literal("jsonl"),
      where: match.optional().describe("Keep only records matching this."),
      errorWhen: match.optional().describe("Terminal-error record: extraction fails if seen."),
      path: dotPath,
      take: z.enum(["first", "last"]),
    }),
  ])
  .describe("Declarative, bounded output extraction. No code, no regexes.");

const argvElement = z.string();
const autonomyFragment = z.array(argvElement);
const autonomyEnvFragment = z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string());

export const modelsExtractSchema = z
  .discriminatedUnion("kind", [
    z
      .strictObject({
        kind: z.literal("lines"),
        separator: z.string().min(1).optional(),
      })
      .describe(
        "One slug per non-blank line; with separator, the slug is the text before it and other lines are skipped.",
      ),
    z
      .strictObject({
        kind: z.literal("json"),
        path: dotPath,
        slug: dotPath.optional().describe("Dot-path to the slug inside each array element."),
        where: match.optional().describe("Keep only entries matching this."),
      })
      .describe(
        "stdout is one JSON document; an array at path yields elements, an object yields its keys.",
      ),
  ])
  .describe("How model slugs are lifted out of the listing command's stdout.");

export const adapterSpecSchema = z.strictObject({
  app: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]*$/)
    .describe("App id, lowercase: 'cursor-agent'. Must not collide with a built-in adapter."),
  adapterVersion: z.int().positive(),
  binary: z
    .string()
    .min(1)
    .describe(
      "Executable path or command name. Registration resolves installed commands to absolute paths.",
    ),
  identityEnv: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]*$/)
    .optional()
    .describe("Env var relocating this app's config/credentials, if it has one. Omit if not."),
  models: z
    .array(z.strictObject({ model: z.string().min(1), slug: z.string().min(1) }))
    .min(1)
    .describe(
      "Pinned routes: canonical model id ↔ app-native slug, distinct ids. Optional diagnostics use an available route.",
    ),
  listModels: z
    .strictObject({
      argv: z
        .array(argvElement)
        .describe("argv AFTER the binary that prints the models. No placeholders."),
      extract: modelsExtractSchema,
    })
    .optional()
    .describe(
      "How the app lists the models it can serve right now. Every slug it reports becomes a route under its own name; declare it whenever the CLI has such a command.",
    ),
  acceptsSlugs: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Globs ('*' wildcard) of model names routed to this app as-is when it has no listing command but accepts full model ids (e.g. 'claude-*').",
    ),
  invoke: z.strictObject({
    argv: z
      .array(argvElement)
      .describe(
        "argv AFTER the binary. Placeholders substituted as single elements: {slug} exactly once, " +
          "{prompt} only when promptVia is 'argv', optional {autonomyFlags} (else flags are appended).",
      ),
    promptVia: z.enum(["stdin", "argv"]).describe("Prefer stdin where the CLI supports it."),
    extract: extractSchema,
  }),
  autonomyFlags: z
    .strictObject({
      readonly: autonomyFragment.optional(),
      edits: autonomyFragment.optional(),
      full: autonomyFragment.optional(),
    })
    .describe("argv fragment per autonomy level. A missing level means unsupported — never faked."),
  autonomyEnv: z
    .strictObject({
      readonly: autonomyEnvFragment.optional(),
      edits: autonomyEnvFragment.optional(),
      full: autonomyEnvFragment.optional(),
    })
    .optional()
    .describe(
      "Env vars set for a level, for apps whose permission model is config rather than flags. Layered over the callee env last.",
    ),
  sessionRef: extractSchema.optional().describe("Where the app prints its session/thread id."),
  cooldownScope: z.literal("provider").optional(),
  resume: z
    .strictObject({ argv: z.array(argvElement) })
    .optional()
    .describe(
      "argv template that continues an existing session; {sessionRef} exactly once marks the handle. " +
        "Omit unless you verified a non-interactive resume — Baton refuses to resume rather than guess.",
    ),
  defaultAutonomy: autonomySchema,
  defaultTimeoutMs: z
    .int()
    .positive()
    .optional()
    .describe("Omit: Baton sets no deadline of its own, so a long run is never cut short."),
  admissionFailurePatterns: z
    .array(argvElement)
    .describe(
      "Case-insensitive PLAIN substrings proving a rate-limit/auth rejection BEFORE work started.",
    ),
  workStartedPatterns: z
    .array(argvElement)
    .optional()
    .describe("Plain substrings proving the callee began working (first stream event, tool call)."),
});

export type AdapterSpec = z.infer<typeof adapterSpecSchema>;
export type ExtractSpec = z.infer<typeof extractSchema>;
export type ModelsExtractSpec = z.infer<typeof modelsExtractSchema>;
export type InvokeSpec = AdapterSpec["invoke"];
export type ListModelsSpec = NonNullable<AdapterSpec["listModels"]>;
export type RouteSpec = AdapterSpec["models"][number];
