import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { killProcessGroup } from "../adapters/executor.ts";

export type ProbeEnv = Record<string, string | undefined>;
export interface ProbeResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}
const MAX_BYTES = 2 * 1024 * 1024;
let active = 0;
const queue: Array<() => void> = [];

/** Limit concurrent CLI probes without blocking the server's timers or output pipes. */
export async function probe(
  binary: string,
  argv: string[],
  env: ProbeEnv,
  timeoutMs: number,
): Promise<ProbeResult> {
  if (active >= 4) await new Promise<void>((resolve) => queue.push(resolve));
  else active++;
  try {
    return await new Promise<ProbeResult>((resolve) => {
      const child = spawn(binary, argv, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let bytes = 0;
      let timedOut = false;
      let finished = false;
      let failure: string | undefined;
      let termination: Promise<unknown> | undefined;
      const stop = (): void => {
        if (termination) return;
        termination = child.pid
          ? killProcessGroup(child.pid, { graceMs: 100, deadlineMs: 2000 })
          : Promise.resolve();
        void termination.then(() => finish(null));
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      const finish = (exitCode: number | null): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const result = {
          stdout: Buffer.concat(out).toString(),
          stderr: failure ?? Buffer.concat(err).toString(),
          exitCode: failure ? 1 : exitCode,
          timedOut,
        };
        if (termination) void termination.then(() => resolve(result));
        else resolve(result);
      };
      const capture = (chunks: Buffer[], data: Buffer): void => {
        bytes += data.length;
        if (bytes > MAX_BYTES) {
          failure = `probe output exceeded ${MAX_BYTES} bytes`;
          stop();
        } else chunks.push(data);
      };
      child.stdout?.on("data", (data) => capture(out, data));
      child.stderr?.on("data", (data) => capture(err, data));
      child.on("error", (error) => {
        failure = error.message;
        finish(null);
      });
      child.on("close", (code) => finish(code));
    });
  } finally {
    const next = queue.shift();
    if (next) next();
    else active--;
  }
}

export function binaryStamp(path: string): string | null {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
}
const versions = new Map<
  string,
  { stamp: string | null; at: number; result: Promise<string | undefined> }
>();
export async function probeVersion(
  binary: string,
  env: ProbeEnv = process.env,
): Promise<string | undefined> {
  const stamp = binaryStamp(binary);
  const key = `${binary}\0${environmentKey(env)}`;
  const previous = versions.get(key);
  if (previous && previous.stamp === stamp && Date.now() - previous.at < 60_000)
    return previous.result;
  const result = probe(binary, ["--version"], env, 5000).then((res) =>
    res.exitCode === 0 && !res.timedOut ? res.stdout.trim().split("\n")[0] || undefined : undefined,
  );
  versions.set(key, { stamp, at: Date.now(), result });
  return result;
}

/** Hash the effective environment so cache files never contain credential values. */
export function environmentKey(env: ProbeEnv): string {
  return new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify(
        Object.entries(env)
          .filter(([, value]) => value !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    )
    .digest("hex");
}
