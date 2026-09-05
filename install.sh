#!/bin/sh
# Installs a prebuilt Baton binary. When run from a checkout, it builds from
# source instead. Override the destination with BATON_INSTALL_DIR.
set -eu

REPO="${BATON_REPO:-danieldunderfelt/baton}"
VERSION="${BATON_VERSION:-latest}"
DEST="${BATON_INSTALL_DIR:-$HOME/.local/bin}"
ARTIFACT=""

# `./install.sh` is the source-build path for contributors. A script piped
# from curl has $0 set to the shell name, so it takes the release path below.
case "$0" in
  */install.sh|install.sh)
    SOURCE_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
    if [ -f "$SOURCE_DIR/package.json" ] && [ -f "$SOURCE_DIR/src/index.ts" ]; then
      if ! command -v bun >/dev/null 2>&1; then
        echo "Baton needs Bun to build from a checkout. Use the prebuilt installer instead:" >&2
        echo "  curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | sh" >&2
        exit 1
      fi
      cd "$SOURCE_DIR"
      bun install --silent
      bun run build
      ARTIFACT="$SOURCE_DIR/dist/baton"
    fi
    ;;
esac

TEMP_DIR=""
INSTALL_TMP=""
cleanup() {
  if [ -n "$TEMP_DIR" ]; then rm -rf "$TEMP_DIR"; fi
  if [ -n "$INSTALL_TMP" ]; then rm -f "$INSTALL_TMP"; fi
}
trap cleanup EXIT HUP INT TERM

if [ -z "$ARTIFACT" ]; then
  OS=$(uname -s)
  ARCH=$(uname -m)
  case "$OS:$ARCH" in
    Darwin:arm64|Darwin:aarch64) TARGET="darwin-arm64" ;;
    Darwin:x86_64|Darwin:amd64) TARGET="darwin-x64" ;;
    Linux:arm64|Linux:aarch64) TARGET="linux-arm64" ;;
    Linux:x86_64|Linux:amd64) TARGET="linux-x64" ;;
    *)
      echo "Baton has no prebuilt binary for $OS/$ARCH. Supported targets: macOS and Linux on arm64 or x64." >&2
      exit 1
      ;;
  esac

  if ! command -v curl >/dev/null 2>&1; then
    echo "Baton's prebuilt installer needs curl." >&2
    exit 1
  fi

  TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/baton-install.XXXXXX")
  if [ "$VERSION" = "latest" ]; then
    BASE_URL="https://github.com/$REPO/releases/latest/download"
  else
    BASE_URL="https://github.com/$REPO/releases/download/$VERSION"
  fi
  ARTIFACT="$TEMP_DIR/baton-$TARGET"
  echo "Downloading Baton $VERSION for $OS/$ARCH..."
  curl --fail --location --silent --show-error "$BASE_URL/baton-$TARGET" -o "$ARTIFACT"

  # Releases include SHA256SUMS. Refuse an unverified download instead of
  # silently turning a convenience installer into a trust-on-first-use path.
  curl --fail --location --silent --show-error "$BASE_URL/SHA256SUMS" -o "$TEMP_DIR/SHA256SUMS"
  EXPECTED=$(awk -v name="baton-$TARGET" '$2 == name { print $1 }' "$TEMP_DIR/SHA256SUMS")
  if [ -z "$EXPECTED" ]; then
    echo "No checksum found for baton-$TARGET in the release." >&2
    exit 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL=$(sha256sum "$ARTIFACT" | awk '{ print $1 }')
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL=$(shasum -a 256 "$ARTIFACT" | awk '{ print $1 }')
  else
    echo "Baton's prebuilt installer needs sha256sum or shasum to verify the download." >&2
    exit 1
  fi
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "Checksum verification failed for baton-$TARGET." >&2
    exit 1
  fi
fi

mkdir -p "$DEST"
INSTALL_TMP=$(mktemp "$DEST/.baton.XXXXXX")
cp "$ARTIFACT" "$INSTALL_TMP"
chmod +x "$INSTALL_TMP"

# macOS kills a Mach-O whose signature does not match the bytes at that path,
# and copying over an existing install invalidates the ad-hoc signature Bun
# minted. Without this the freshly installed baton dies with SIGKILL (137) and
# the stale one in memory is the last thing that worked.
if [ "$(uname -s)" = "Darwin" ] && command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$INSTALL_TMP" >/dev/null 2>&1 ||
    echo "Warning: could not re-sign $INSTALL_TMP; if it exits 137, run: codesign --force --sign - $DEST/baton" >&2
fi
mv -f "$INSTALL_TMP" "$DEST/baton"
INSTALL_TMP=""

echo "Installed: $DEST/baton"
case ":$PATH:" in
  *":$DEST:"*) ;;
  *) echo "Note: $DEST is not on your PATH. Add it, e.g.: export PATH=\"$DEST:\$PATH\"" ;;
esac

echo
echo "Next, register Baton with every agent app on this machine, once:"
echo "  baton install --user"
echo "Later, 'baton update' fetches the latest release."
