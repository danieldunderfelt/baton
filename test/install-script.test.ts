import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = readFileSync(resolve(import.meta.dir, "../install.sh"), "utf8");
const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixture({ old = false, badChecksum = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "baton-shell-install-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  const dest = join(dir, "installed");
  mkdirSync(bin);
  mkdirSync(dest);
  writeFileSync(join(dest, "baton"), "original install");
  const binary = `#!/bin/sh\ncase "$1" in\n--version) echo ${old ? "0.1.0" : "0.2.0"};;\n--help) echo '${old ? "baton install <host>" : "baton install --user; baton update"}';;\nesac\n`;
  writeFileSync(join(dir, "artifact"), binary);
  const hash = new Bun.CryptoHasher("sha256").update(badChecksum ? "wrong" : binary).digest("hex");
  writeFileSync(join(dir, "sums"), `${hash}  baton-linux-x64\n`);
  writeFileSync(
    join(bin, "uname"),
    '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|--output) output="$2"; shift ;;
    https://*) url="$1" ;;
  esac
  shift
done
echo "$url" >> "$FIXTURE/requests"
case "$url" in
  */releases/latest) printf 'https://github.com/danieldunderfelt/baton/releases/tag/v0.2.0' ;;
  */download/v0.2.0/baton-linux-x64) cp "$FIXTURE/artifact" "$output" ;;
  */download/v0.2.0/SHA256SUMS) cp "$FIXTURE/sums" "$output" ;;
  *) echo "unexpected URL: $url" >&2; exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  const run = () =>
    Bun.spawnSync(["/bin/sh"], {
      cwd: dir,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, FIXTURE: dir, BATON_INSTALL_DIR: dest },
      stdin: new TextEncoder().encode(script),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
  return { dir, dest, binary, run };
}

test("piped installer pins binary and checksum to one release and installs a runnable binary", () => {
  const f = fixture();
  const result = f.run();
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(readFileSync(join(f.dest, "baton"), "utf8")).toBe(f.binary);
  expect(result.stdout.toString()).toContain("install --user");
  expect(readFileSync(join(f.dir, "requests"), "utf8")).not.toContain("latest/download");
});

test("checksum failure preserves the installed binary", () => {
  const f = fixture({ badChecksum: true });
  const result = f.run();
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("Checksum verification failed");
  expect(readFileSync(join(f.dest, "baton"), "utf8")).toBe("original install");
});

test("latest release missing documented commands is refused before replacing the install", () => {
  const f = fixture({ old: true });
  const result = f.run();
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("predates 'install --user' and 'update'");
  expect(readFileSync(join(f.dest, "baton"), "utf8")).toBe("original install");
  expect(existsSync(join(f.dir, ".claude.json"))).toBe(false);
});
