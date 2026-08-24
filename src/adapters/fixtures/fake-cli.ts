#!/usr/bin/env bun
/**
 * Test double for a callee agent CLI. Behaviour is chosen by BATON_FAKE_MODE
 * so that argv stays entirely under the test's control (the executor's argv
 * substitution is itself under test). Never invoked outside tests.
 */

const mode = Bun.env.BATON_FAKE_MODE ?? "text";
const args = process.argv.slice(2);

const write = (s: string) => Bun.write(Bun.stdout, s);
const writeErr = (s: string) => Bun.write(Bun.stderr, s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (key: string, fallback: number) => Number(Bun.env[key] ?? fallback);

switch (mode) {
  case "text":
    await write("  final answer from text mode \n");
    break;

  case "json":
    await write(
      `${JSON.stringify({
        session_id: "sess-42",
        result: { text: "final answer from json mode", items: ["alpha", "beta"] },
      })}\n`,
    );
    break;

  case "jsonl":
    await write("starting up, not json\n");
    await write(`${JSON.stringify({ type: "tool", name: "read" })}\n`);
    await write(`${JSON.stringify({ type: "message", text: "first message" })}\n`);
    await write("{ broken json\n");
    await write(`${JSON.stringify({ type: "message", text: "last message" })}\n`);
    await write(`${JSON.stringify({ type: "usage", tokens: 12 })}\n`);
    break;

  case "argv":
    await write(`${JSON.stringify({ argv: args })}\n`);
    break;

  case "stdin": {
    const stdin = await Bun.stdin.text();
    await write(`${JSON.stringify({ echo: stdin })}\n`);
    break;
  }

  case "sleep":
    await sleep(num("BATON_FAKE_SLEEP_MS", 30_000));
    break;

  case "grandchild": {
    const { spawn } = await import("node:child_process");
    const grandchild = spawn("sleep", ["30"], { stdio: "ignore" });
    await write(`${JSON.stringify({ grandchildPid: grandchild.pid })}\n`);
    await sleep(num("BATON_FAKE_SLEEP_MS", 30_000));
    break;
  }

  // Same as "grandchild", but the descendant ignores SIGTERM: only a SIGKILL
  // of the group ends it, which is what the executor must wait for.
  case "stubborn-grandchild": {
    const { spawn } = await import("node:child_process");
    const grandchild = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 300_000)"],
      { stdio: "ignore" },
    );
    await write(`${JSON.stringify({ grandchildPid: grandchild.pid })}\n`);
    await sleep(num("BATON_FAKE_SLEEP_MS", 30_000));
    break;
  }

  // Session line first, then more noise than the output cap can hold.
  case "session-head": {
    await write(`${JSON.stringify({ type: "thread.started", thread_id: "th-99" })}\n`);
    const total = num("BATON_FAKE_BIG_BYTES", 40_000);
    const line = `${JSON.stringify({ type: "tool", name: "X".repeat(180) })}\n`;
    for (let written = 0; written < total; written += line.length) await write(line);
    await write(`${JSON.stringify({ type: "message", text: "final answer" })}\n`);
    break;
  }

  // A run that worked for a while — tool events, a message part — and only
  // then hit a rate limit. The admission text is real but arrives too late to
  // be an admission failure.
  case "work-then-limit":
    await write(`${JSON.stringify({ type: "step_start" })}\n`);
    await write(`${JSON.stringify({ type: "tool", name: "edit", path: "src/a.ts" })}\n`);
    await write(`${JSON.stringify({ type: "text", part: { text: "edited three files" } })}\n`);
    await writeErr(`${Bun.env.BATON_FAKE_STDERR ?? "usage limit reached, retry after 5pm"}\n`);
    process.exit(num("BATON_FAKE_EXIT", 1));

  // Streams a usable answer and then a terminal error event, exiting 0 — the
  // shape that made a partial answer look successful.
  case "text-then-error":
    await write(`${JSON.stringify({ type: "text", part: { text: "partial answer" } })}\n`);
    await write(
      `${JSON.stringify({
        type: "error",
        error: { name: "APIError", data: { message: "Upstream request failed", statusCode: 503 } },
      })}\n`,
    );
    break;

  case "fail":
    await writeErr(`${Bun.env.BATON_FAKE_STDERR ?? "rate limit exceeded, retry later"}\n`);
    process.exit(num("BATON_FAKE_EXIT", 3));

  case "big": {
    const total = num("BATON_FAKE_BIG_BYTES", 8192);
    const marker = Bun.env.BATON_FAKE_MARKER ?? "TAILMARKER";
    await write("X".repeat(Math.max(0, total - marker.length)) + marker);
    break;
  }

  default:
    await writeErr(`unknown BATON_FAKE_MODE: ${mode}\n`);
    process.exit(64);
}
