#!/usr/bin/env bash
set -euo pipefail

ROOT="$(pwd)"
TMP="$(mktemp -d)"

cleanup() {
  set +e
  if [ -d "$TMP" ]; then
    cd "$TMP" 2>/dev/null || true
    if [ -f .env ]; then
      docker compose --env-file .env down -v --remove-orphans >/dev/null 2>&1 || true
    fi
  fi
  cd "$ROOT" 2>/dev/null || true
  git worktree remove --force "$TMP" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# Use a clean checkout so the test matches the documented first-install path.
git worktree add --detach "$TMP" HEAD >/dev/null
cd "$TMP"

bash scripts/deploy-linux.sh "http://127.0.0.1:8080"

test -f .env
EXPECTED_SHA="$(git rev-parse HEAD)"
ENV_SHA="$(grep '^BUILD_SHA=' .env | tail -n1 | cut -d= -f2-)"
ADMIN_PASSWORD="$(grep '^ADMIN_PASSWORD=' .env | tail -n1 | cut -d= -f2-)"
MASTER_KEY="$(grep '^APP_MASTER_KEY=' .env | tail -n1 | cut -d= -f2-)"

[ "$ENV_SHA" = "$EXPECTED_SHA" ]
[ "$ADMIN_PASSWORD" != 'change-this-password' ]
[ "$MASTER_KEY" != 'change-this-to-a-long-random-secret-at-least-32-characters' ]
[ "${#ADMIN_PASSWORD}" -ge 12 ]
[ "${#MASTER_KEY}" -ge 32 ]

HEALTH="$(curl -fsS http://127.0.0.1:8080/api/health)"
jq -e --arg sha "$EXPECTED_SHA" '.ok == true and .buildSha == $sha and .schemaVersion == 6' <<<"$HEALTH" >/dev/null

MOUNT="$(docker inspect publikator --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Type}}:{{.Name}}{{end}}{{end}}')"
[[ "$MOUNT" == volume:* ]]

echo "Linux deploy launcher PASS: $MOUNT / $EXPECTED_SHA"
