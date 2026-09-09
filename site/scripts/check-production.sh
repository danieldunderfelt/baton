#!/usr/bin/env bash
set -euo pipefail

# Run the built Worker and assets against disposable local D1. No GitHub calls.
audit_dir=$(mktemp -d)
audit_port=${BATON_SITE_TEST_PORT:-8794}
audit_origin="http://127.0.0.1:$audit_port"
audit_pid=
cleanup() {
  if [ -n "$audit_pid" ]; then
    kill "$audit_pid" 2>/dev/null || true
    wait "$audit_pid" 2>/dev/null || true
  fi
  rm -rf "$audit_dir"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

bunx wrangler d1 migrations apply baton --local --persist-to "$audit_dir/state" > "$audit_dir/migrate.log" 2>&1 || {
  cat "$audit_dir/migrate.log"
  exit 1
}
bunx wrangler dev --local --port "$audit_port" --persist-to "$audit_dir/state" \
  --var GITHUB_CLIENT_ID:audit-test --var GITHUB_CLIENT_SECRET:audit-test \
  --var "SITE_URL:$audit_origin" > "$audit_dir/server.log" 2>&1 &
audit_pid=$!
curl --silent --show-error --fail --retry 20 --retry-connrefused --retry-delay 1 \
  "$audit_origin/" > /dev/null 2> "$audit_dir/curl.log" || {
  cat "$audit_dir/server.log" "$audit_dir/curl.log"
  exit 1
}

check() {
  local path=$1 expected=$2
  local status
  status=$(curl --silent --show-error --max-time 10 -D "$audit_dir/headers" \
    -o "$audit_dir/body" -w '%{http_code}' "$audit_origin$path")
  if [ "$status" != "$expected" ]; then
    cat "$audit_dir/server.log"
    echo "$path: expected $expected, got $status" >&2
    exit 1
  fi
  grep -qi '^x-frame-options: DENY' "$audit_dir/headers"
  grep -qi '^content-security-policy: .*frame-ancestors' "$audit_dir/headers"
}

check / 200
check /docs/installation/ 200
check /device 200
check /p/aaaaa-aaaaa 404
grep -q 'Nothing here.' "$audit_dir/body"
check /not-a-route 404
grep -q 'Nothing here.' "$audit_dir/body"
check '/api/auth/github?next=/account' 302
grep -qi '^set-cookie: baton_oauth=' "$audit_dir/headers"
grep -qi '^location: https://github.com/login/oauth/authorize?' "$audit_dir/headers"
echo 'Production checks passed: static headers, device page, missing shares, 404 and OAuth state cookie.'
