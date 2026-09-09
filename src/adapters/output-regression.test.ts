import { expect, test } from "bun:test";
import { executeAdapter, classifyFailure } from "./executor.ts";
import type { ExecRequest } from "./types.ts";
function request(code: string): ExecRequest {
  return {
    spec: {
      app: "fixture",
      adapterVersion: 1,
      binary: process.execPath,
      models: [],
      invoke: { argv: ["-e", code], promptVia: "stdin", extract: { kind: "json", path: "result" } },
      autonomyFlags: { full: [] },
      defaultAutonomy: "full",
      admissionFailurePatterns: ["usage limit reached"],
      workStartedPatterns: ['"type":"tool"'],
      sessionRef: { kind: "json", path: "session_id" },
    },
    slug: "fixture",
    prompt: "",
    cwd: "/tmp",
    env: {},
    autonomy: "full",
    timeoutMs: 5000,
  };
}
test("large JSON result survives raw diagnostic tail limit", async () => {
  const result = await executeAdapter(
    request(
      'await Bun.write(Bun.stdout,JSON.stringify({session_id:"s",result:"answer",details:"x".repeat(1100000)}))',
    ),
  );
  expect(result.ok, result.error).toBe(true);
  expect(result.output).toBe("answer");
  expect(result.sessionRef).toBe("s");
  expect(result.rawTail.length).toBeLessThanOrEqual(1000000);
});
test("work before a long log is never reclassified as admission refusal", async () => {
  const req = request(
    'await Bun.write(Bun.stdout,\'{"type":"tool"}\\n\');await Bun.write(Bun.stdout,"x".repeat(1100000));await Bun.write(Bun.stderr,"usage limit reached");process.exit(1)',
  );
  const result = await executeAdapter(req);
  expect(result.rawTail).not.toContain('"type":"tool"');
  expect(classifyFailure(req.spec, result)).toBe("failure");
});

test("work markers survive a stream chunk boundary", async () => {
  const req = request(
    'await Bun.write(Bun.stdout,\'{"type":\');await Bun.sleep(30);await Bun.write(Bun.stdout,\'"tool"}\\n\');await Bun.write(Bun.stderr,"usage limit reached");process.exit(1)',
  );
  const result = await executeAdapter(req);
  expect(result.workStarted).toBe(true);
  expect(classifyFailure(req.spec, result)).toBe("failure");
});

test("an oversized JSON envelope fails explicitly without a partial session", async () => {
  const result = await executeAdapter(
    request(
      'await Bun.write(Bun.stdout,JSON.stringify({session_id:"s",result:"answer",details:"x".repeat(17*1024*1024)}))',
    ),
  );
  expect(result.ok).toBe(false);
  expect(result.error).toContain("JSON output exceeded");
  expect(result.sessionRef).toBeUndefined();
});
