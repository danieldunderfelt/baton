/**
 * Markdown imported with `with { type: "text" }`. bun-types declares .txt and
 * friends but not .md, and the templates must be *bundled* — a compiled
 * `bun build --compile` binary has no source tree to read them from at runtime.
 */
declare module "*.md" {
  const content: string;
  export default content;
}
