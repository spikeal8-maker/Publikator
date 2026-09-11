#!/usr/bin/env bash
set -euo pipefail

PUBLIC_URL="${1:-http://127.0.0.1:8080}"

command -v docker >/dev/null || { echo 'Docker is required'; exit 1; }
docker compose version >/dev/null

if [ ! -f .env ]; then
  ADMIN_SECRET="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
  MASTER_SECRET="$(od -An -N48 -tx1 /dev/urandom | tr -d ' \n')"
  BUILD_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
  cat > .env <<EOF
PUBLIC_BASE_URL=${PUBLIC_URL}
PUBLIKATOR_BIND=127.0.0.1
PUBLIKATOR_PORT=8080
PUBLIKATOR_DATA_SOURCE=publikator-data
TRUST_PROXY=
ADMIN_PASSWORD=${ADMIN_SECRET}
APP_MASTER_KEY=${MASTER_SECRET}
SESSION_TTL_HOURS=24
SCHEDULER_INTERVAL_MS=15000
QUEUE_SLOT_GRACE_MINUTES=60
EVENT_RETENTION_DAYS=180
BACKUP_RETENTION_COUNT=30
BUILD_SHA=${BUILD_SHA}
RELEASE_TARGET_VERSION=1.0.0
EOF
  chmod 600 .env || true
  echo 'Created .env with random ADMIN_PASSWORD and APP_MASTER_KEY.'
else
  echo 'Using existing .env; it was not modified.'
fi

docker compose --env-file .env config >/dev/null
docker compose --env-file .env up -d --build

for _ in $(seq 1 60); do
  STATUS="$(docker inspect publikator --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
  [ "$STATUS" = 'healthy' ] && break
  sleep 1
done

STATUS="$(docker inspect publikator --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
if [ "$STATUS" != 'healthy' ]; then
  docker compose --env-file .env logs --tail=100 publikator
  echo "Publikator did not become healthy: ${STATUS:-missing}"
  exit 1
fi

echo 'Publikator is healthy.'
echo 'Local UI: http://127.0.0.1:8080'
echo 'Credentials are stored only in .env. Keep APP_MASTER_KEY safe.'
