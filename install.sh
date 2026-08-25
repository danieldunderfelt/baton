#!/bin/sh
# Builds Baton from source and installs the binary. Override the destination
# with BATON_INSTALL_DIR (default: ~/.local/bin).
set -eu

if ! command -v bun >/dev/null 2>&1; then
  echo "Baton needs Bun to build. Install it first: https://bun.sh" >&2
  exit 1
fi

cd "$(dirname "$0")"
bun install --silent
bun run build

DEST="${BATON_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$DEST"
cp dist/baton "$DEST/baton"
chmod +x "$DEST/baton"

# macOS kills a Mach-O whose signature does not match the bytes at that path,
# and copying over an existing install invalidates the ad-hoc signature Bun
# minted. Without this the freshly installed baton dies with SIGKILL (137) and
# the stale one in memory is the last thing that worked.
if [ "$(uname -s)" = "Darwin" ] && command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$DEST/baton" >/dev/null 2>&1 ||
    echo "Warning: could not re-sign $DEST/baton; if it exits 137, run: codesign --force --sign - $DEST/baton" >&2
fi

echo "Installed: $DEST/baton"
case ":$PATH:" in
  *":$DEST:"*) ;;
  *) echo "Note: $DEST is not on your PATH. Add it, e.g.: export PATH=\"$DEST:\$PATH\"" ;;
esac

echo
echo "Next, register Baton with the agent apps you use:"
echo "  baton install claude-code --with-eval"
echo "  baton install codex --with-eval"
echo "  baton install kimi --with-eval"
echo "  baton install opencode --with-eval"
echo "Then check what this machine can reach:  baton detect"
