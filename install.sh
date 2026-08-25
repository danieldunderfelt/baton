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
