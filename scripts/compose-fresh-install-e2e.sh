#!/usr/bin/env bash
set -euo pipefail

ENV_FILE=/tmp/publikator-compose-fresh.env
export COMPOSE_PROJECT_NAME=publikator-ci-fresh

cleanup() {
  docker compose --env-file "$ENV_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$ENV_FILE"
}
trap cleanup EXIT
cleanup

cat > "$ENV_FILE" <<EOF
PUBLIC_BASE_URL=http://127.0.0.1:18084
PUBLIKATOR_BIND=127.0.0.1
PUBLIKATOR_PORT=18084
PUBLIKATOR_DATA_SOURCE=publikator-data
TRUST_PROXY=
ADMIN_PASSWORD=compose-fresh-password-value
APP_MASTER_KEY=compose-fresh-master-key-value-longer-than-thirty-two-characters
BUILD_SHA=${GITHUB_SHA:-unknown}
RELEASE_TARGET_VERSION=1.0.0
EOF

docker compose --env-file "$ENV_FILE" config >/dev/null
docker compose --env-file "$ENV_FILE" up -d --build

wait_healthy() {
  for _ in $(seq 1 60); do
    STATUS="$(docker inspect publikator --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
    [ "$STATUS" = healthy ] && return 0
    sleep 1
  done
  docker compose --env-file "$ENV_FILE" logs --tail=100 publikator
  return 1
}

wait_healthy
HEALTH="$(curl -fsS http://127.0.0.1:18084/api/health)"
jq -e '.ok == true and .schemaVersion == 6' <<<"$HEALTH"

MOUNT="$(docker inspect publikator --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Type}}:{{.Name}}{{end}}{{end}}')"
[[ "$MOUNT" == volume:* ]]

docker exec publikator sh -c 'echo persisted > /app/data/compose-persist.txt'
IMAGE_ID="$(docker inspect publikator --format '{{.Image}}')"

docker compose --env-file "$ENV_FILE" down
docker compose --env-file "$ENV_FILE" up -d
wait_healthy
docker exec publikator test -f /app/data/compose-persist.txt

set +e
docker run --rm \
  -e ADMIN_PASSWORD=change-this-password \
  -e APP_MASTER_KEY=change-this-to-a-long-random-secret-at-least-32-characters \
  "$IMAGE_ID" >/tmp/publikator-placeholder.out 2>&1
PLACEHOLDER_EXIT=$?
set -e
[ "$PLACEHOLDER_EXIT" -ne 0 ]
grep -F 'public example placeholder' /tmp/publikator-placeholder.out >/dev/null

echo "Compose fresh-install PASS: $MOUNT"
