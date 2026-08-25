#!/usr/bin/env bun
/**
 * A "previously unknown agent app" for the phase-3 exit-criterion rehearsal
 * (test/onboarding.e2e.test.ts). It behaves like the non-interactive surface of
 * a real agent CLI — `--version`, a prompt on stdin, JSONL on stdout carrying a
 * session id and a result record — without a model, a network call or a
 * subscription behind it.
 *
 * Its answer is deliberately trivial and checkable: the canary token when the
 * prompt asks for it, otherwise the last line of the prompt echoed back. That
 * is enough to prove the whole path — argv template, prompt delivery, declared
 * extraction — carried a real answer end to end.
 */

const args = process.argv.slice(2);

if (args.includes("--version")) {
  await Bun.write(Bun.stdout, `fake-onboarding-cli 1.2.3\n`);
  process.exit(0);
}

const CANARY_TOKEN = "BATON_CANARY";

const prompt = await Bun.stdin.text();
const lines = prompt
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0);

const answer = prompt.includes(CANARY_TOKEN) ? CANARY_TOKEN : (lines.at(-1) ?? "");

const emit = (record: unknown): Promise<number> =>
  Bun.write(Bun.stdout, `${JSON.stringify(record)}\n`);

// Session first, then a chatty middle record, then the result: an extractor
// that grabs the wrong record shows up as a wrong answer, not a pass.
await emit({ type: "init", session_id: "sess_fake_onboarding" });
await emit({ type: "assistant", text: "thinking about it" });
await emit({ type: "result", is_error: "false", result: answer, argv: args });
