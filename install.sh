#!/bin/sh
# Installs a prebuilt Baton binary. When run from a checkout, it builds from
# source instead. Override the destination with BATON_INSTALL_DIR.
set -eu

REPO="${BATON_REPO:-danieldunderfelt/baton}"
VERSION="${BATON_VERSION:-latest}"
REQUESTED_VERSION="$VERSION"
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
      bun install --frozen-lockfile --silent
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
    RELEASE_URL=$(curl --fail --location --silent --show-error --output /dev/null --write-out '%{url_effective}' "https://github.com/$REPO/releases/latest")
    case "$RELEASE_URL" in
      "https://github.com/$REPO/releases/tag/"*) VERSION=${RELEASE_URL##*/} ;;
      *) echo "Could not resolve the latest Baton release: $RELEASE_URL" >&2; exit 1 ;;
    esac
  fi
  BASE_URL="https://github.com/$REPO/releases/download/$VERSION"
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
chmod 755 "$INSTALL_TMP"

# macOS kills a Mach-O whose signature does not match the bytes at that path,
# and copying over an existing install invalidates the ad-hoc signature Bun
# minted. Without this the freshly installed baton dies with SIGKILL (137) and
# the stale one in memory is the last thing that worked.
if [ "$(uname -s)" = "Darwin" ] && command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$INSTALL_TMP" >/dev/null 2>&1 ||
    echo "Warning: could not re-sign $INSTALL_TMP; if it exits 137, run: codesign --force --sign - $DEST/baton" >&2
fi
INSTALLED_VERSION=$("$INSTALL_TMP" --version) || {
  echo "The downloaded Baton binary does not run on this machine; the existing install was kept." >&2
  exit 1
}
HELP_TEXT=$("$INSTALL_TMP" --help)
if [ "$REQUESTED_VERSION" = "latest" ]; then
  case "$HELP_TEXT" in
    *'baton update'*'--user'*|*'--user'*'baton update'*) ;;
    *)
      echo "Release $INSTALLED_VERSION predates 'install --user' and 'update'. The existing install was kept." >&2
      echo "Build current sources with Bun: git clone https://github.com/$REPO.git && cd baton && ./install.sh" >&2
      exit 1
      ;;
  esac
fi
mv -f "$INSTALL_TMP" "$DEST/baton"
INSTALL_TMP=""

echo "Installed Baton $INSTALLED_VERSION: $DEST/baton"
case ":$PATH:" in
  *":$DEST:"*) ;;
  *) echo "Note: $DEST is not on your PATH. Add it, e.g.: export PATH=\"$DEST:\$PATH\"" ;;
esac
RESOLVED=$(command -v baton || true)
if [ -n "$RESOLVED" ] && [ "$RESOLVED" != "$DEST/baton" ]; then
  echo "Note: your PATH selects $RESOLVED. Put $DEST first, or run $DEST/baton directly."
fi

echo
case "$HELP_TEXT" in
  *'--user'*)
    echo "Next, register Baton with every agent app on this machine, once:"
    echo "  \"$DEST/baton\" install --user"
    echo "Later, 'baton update' fetches the latest release."
    ;;
  *) echo "This pinned release uses older commands. Run \"$DEST/baton\" --help for usage." ;;
esac
