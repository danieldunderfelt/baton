#!/usr/bin/env bun
/**
 * Test double for a *discovered* agent CLI: answers `--version` and echoes back
 * the token it was asked for. Behaviour is chosen by env vars so the spec's
 * argv stays entirely under the test's control. Never invoked outside tests.
 */

const args = process.argv.slice(2);

if (args.includes("--version")) {
  await Bun.write(Bun.stdout, `${Bun.env.BATON_FAKE_AGENT_VERSION ?? "fake-agent 1.0.0"}\n`);
  process.exit(0);
}

const mode = Bun.env.BATON_FAKE_AGENT_MODE ?? "echo";
const prompt = await Bun.stdin.text();

switch (mode) {
  case "echo": {
    // Answers with the token the prompt asked for, like a compliant callee.
    const token = prompt.trim().split(/\s+/).at(-1) ?? "";
    await Bun.write(Bun.stdout, `${JSON.stringify({ result: token, argv: args })}\n`);
    break;
  }
  case "wrong":
    await Bun.write(Bun.stdout, `${JSON.stringify({ result: "sure, happy to help!" })}\n`);
    break;
  case "fail":
    await Bun.write(Bun.stderr, "fake-agent: rate limit reached\n");
    process.exit(3);
}
