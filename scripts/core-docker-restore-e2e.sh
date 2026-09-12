#!/usr/bin/env bash
set -euo pipefail

: "${PUBLIKATOR_TEST_ADMIN_PASSWORD:?PUBLIKATOR_TEST_ADMIN_PASSWORD is required}"
: "${PUBLIKATOR_TEST_MASTER_KEY:?PUBLIKATOR_TEST_MASTER_KEY is required}"

IMAGE_NAME="publikator-acceptance"
CONTAINER_NAME="publikator-acceptance-smoke"
PORT="18080"
PASSWORD="$PUBLIKATOR_TEST_ADMIN_PASSWORD"
MASTER_KEY="$PUBLIKATOR_TEST_MASTER_KEY"
COOKIE_FILE="/tmp/publikator-acceptance-cookies.txt"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

rm -rf /tmp/publikator-bundle-check /tmp/publikator-wrong-key
rm -f "$COOKIE_FILE" /tmp/publikator-full.tgz /tmp/publikator-*.png

docker build --pull=false -t "$IMAGE_NAME" .
docker run -d --name "$CONTAINER_NAME" --restart unless-stopped -p "${PORT}:8080" \
  -e ADMIN_PASSWORD="$PASSWORD" \
  -e APP_MASTER_KEY="$MASTER_KEY" \
  "$IMAGE_NAME" >/dev/null

wait_for_health() {
  for _ in $(seq 1 50); do
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  docker logs "$CONTAINER_NAME"
  return 1
}

login() {
  rm -f "$COOKIE_FILE"
  curl -fsS -c "$COOKIE_FILE" \
    -H 'content-type: application/json' \
    --data-binary "$(jq -nc --arg password "$PASSWORD" '{password:$password}')" \
    "http://127.0.0.1:${PORT}/api/auth/login" | jq -e '.ok == true' >/dev/null
}

wait_for_health
login
post_version() {
  curl -fsS -b "$COOKIE_FILE" "http://127.0.0.1:${PORT}/api/posts/$1" | jq -er '.content_version'
}

PROJECT_ID="$(curl -fsS -b "$COOKIE_FILE" "http://127.0.0.1:${PORT}/api/projects" | jq -er '.[0].id')"

OLD_POST_ID="$(curl -fsS -b "$COOKIE_FILE" \
  -H 'content-type: application/json' \
  --data-binary "$(jq -nc --arg projectId "$PROJECT_ID" '{projectId:$projectId,title:"Before account",body:"Must not auto-target future accounts",scheduleMode:"MANUAL"}')" \
  "http://127.0.0.1:${PORT}/api/posts" | jq -er '.id')"

ACCOUNT_ID="$(curl -fsS -b "$COOKIE_FILE" \
  -H 'content-type: application/json' \
  --data-binary "$(jq -nc '{platform:"telegram",name:"CI target",credentials:{botToken:"test-value",chatId:"@test-channel"}}')" \
  "http://127.0.0.1:${PORT}/api/accounts" | jq -er '.id')"
test -n "$ACCOUNT_ID"

curl -fsS -b "$COOKIE_FILE" "http://127.0.0.1:${PORT}/api/posts/${OLD_POST_ID}" | \
  jq -e '(.targets | length) == 1 and (.targets[0].enabled == 0)' >/dev/null

POST_ID="$(curl -fsS -b "$COOKIE_FILE" \
  -H 'content-type: application/json' \
  --data-binary "$(jq -nc --arg projectId "$PROJECT_ID" '{projectId:$projectId,title:"CI post",body:"Smoke test body",scheduleMode:"MANUAL"}')" \
  "http://127.0.0.1:${PORT}/api/posts" | jq -er '.id')"
TARGET_ID="$(curl -fsS -b "$COOKIE_FILE" "http://127.0.0.1:${PORT}/api/posts/${POST_ID}" | jq -er '.targets[] | select(.platform == "telegram") | .id')"

POST_VERSION="$(post_version "$POST_ID")"
curl -fsS -b "$COOKIE_FILE" -X PATCH \
  -H 'content-type: application/json' -H "x-content-version: $POST_VERSION" \
  -d '{"text":"Telegram CI override"}' \
  "http://127.0.0.1:${PORT}/api/posts/${POST_ID}/targets/${TARGET_ID}/text" | \
  jq -e '.ok == true and .target.overrideText == "Telegram CI override"' >/dev/null

node --input-type=module <<'NODE'
import sharp from 'sharp';
await sharp({create:{width:16,height:16,channels:3,background:{r:255,g:255,b:255}}}).png().toFile('/tmp/publikator-white.png');
await sharp({create:{width:32,height:16,channels:3,background:{r:0,g:0,b:0}}}).png().toFile('/tmp/publikator-black.png');
await sharp({create:{width:24,height:24,channels:3,background:{r:255,g:200,b:0}}}).png().toFile('/tmp/publikator-yellow.png');
NODE

POST_VERSION="$(post_version "$POST_ID")"
MEDIA_1="$(curl -fsS -b "$COOKIE_FILE" -H "x-content-version: $POST_VERSION" -F 'file=@/tmp/publikator-white.png;type=image/png' "http://127.0.0.1:${PORT}/api/posts/${POST_ID}/media" | jq -er '.id')"
POST_VERSION="$(post_version "$POST_ID")"
MEDIA_2="$(curl -fsS -b "$COOKIE_FILE" -H "x-content-version: $POST_VERSION" -F 'file=@/tmp/publikator-black.png;type=image/png' "http://127.0.0.1:${PORT}/api/posts/${POST_ID}/media" | jq -er '.id')"
POST_VERSION="$(post_version "$POST_ID")"
DUPLICATE_ID="$(curl -fsS -b "$COOKIE_FILE" -H "x-content-version: $POST_VERSION" -F 'file=@/tmp/publikator-white.png;type=image/png' "http://127.0.0.1:${PORT}/api/posts/${POST_ID}/media" | jq -er '.id')"
test "$DUPLICATE_ID" = "$MEDIA_1"

POST_VERSION="$(post_version "$POST_ID")"
curl -fsS -b "$COOKIE_FILE" -X PUT -H 'content-type: application/json' -H "x-content-version: $POST_VERSION" \
  --data-binary "$(jq -nc --arg a "$MEDIA_2" --arg b "$MEDIA_1" '{mediaIds:[$a,$b]}')" \
  "http://127.0.0.1:${PORT}/api/posts/${POST_ID}/media-order" | \
  jq -e --arg first "$MEDIA_2" '.ok == true and .media[0].id == $first' >/dev/null

POST_VERSION="$(post_version "$POST_ID")"
curl -fsS -b "$COOKIE_FILE" -X POST -H 'content-type: application/json' -H "x-content-version: $POST_VERSION" -d '{}' "http://127.0.0.1:${PORT}/api/posts/${POST_ID}/ready" | jq -e '.ok == true' >/dev/null

BUNDLE_NAME="$(curl -fsS -b "$COOKIE_FILE" -H 'content-type: application/json' -d '{"label":"acceptance"}' \
  "http://127.0.0.1:${PORT}/api/backup-bundles" | jq -er 'select(.sizeBytes > 0) | .name')"
curl -fsS -b "$COOKIE_FILE" "http://127.0.0.1:${PORT}/api/backup-bundles/${BUNDLE_NAME}/download" -o /tmp/publikator-full.tgz
test -s /tmp/publikator-full.tgz
mkdir -p /tmp/publikator-bundle-check
tar -xzf /tmp/publikator-full.tgz -C /tmp/publikator-bundle-check
jq -e '.format == "publikator-backup" and .formatVersion == 1 and .schemaVersion == 5 and .counts.media == 2 and (.mediaFiles | length) == 2' \
  /tmp/publikator-bundle-check/manifest.json >/dev/null
! grep -F "$MASTER_KEY" /tmp/publikator-bundle-check/manifest.json

set +e
DATA_DIR=/tmp/publikator-wrong-key ADMIN_PASSWORD="$PASSWORD" APP_MASTER_KEY="${MASTER_KEY}-different" \
node --input-type=module <<'NODE' >/tmp/publikator-wrong-key.out 2>&1
import { validateBackupDirectory } from './dist/backup-format.js';
await validateBackupDirectory('/tmp/publikator-bundle-check');
NODE
WRONG_KEY_EXIT=$?
set -e
test "$WRONG_KEY_EXIT" -ne 0
grep -F 'APP_MASTER_KEY' /tmp/publikator-wrong-key.out >/dev/null

EXTRA_PROJECT_ID="$(curl -fsS -b "$COOKIE_FILE" -H 'content-type: application/json' \
  -d '{"name":"After backup mutation","slug":"after-backup-mutation"}' "http://127.0.0.1:${PORT}/api/projects" | jq -er '.id')"
EXTRA_POST_ID="$(curl -fsS -b "$COOKIE_FILE" -H 'content-type: application/json' \
  --data-binary "$(jq -nc --arg projectId "$EXTRA_PROJECT_ID" '{projectId:$projectId,title:"Must disappear after restore",body:"Created after backup",scheduleMode:"MANUAL"}')" \
  "http://127.0.0.1:${PORT}/api/posts" | jq -er '.id')"
EXTRA_VERSION="$(post_version "$EXTRA_POST_ID")"
EXTRA_MEDIA_PATH="$(curl -fsS -b "$COOKIE_FILE" -H "x-content-version: $EXTRA_VERSION" -F 'file=@/tmp/publikator-yellow.png;type=image/png' \
  "http://127.0.0.1:${PORT}/api/posts/${EXTRA_POST_ID}/media" | jq -er '.relative_path')"
curl -fsS "http://127.0.0.1:${PORT}/public-media/${EXTRA_MEDIA_PATH}" -o /dev/null

NO_CONFIRM_STATUS="$(curl -sS -o /tmp/publikator-no-confirm.json -w '%{http_code}' -b "$COOKIE_FILE" -X POST \
  "http://127.0.0.1:${PORT}/api/backup-bundles/${BUNDLE_NAME}/restore")"
test "$NO_CONFIRM_STATUS" = "400"

RESTART_BEFORE="$(docker inspect -f '{{.RestartCount}}' "$CONTAINER_NAME")"
curl -fsS -b "$COOKIE_FILE" -H 'x-publikator-restore: RESTORE' \
  -F 'file=@/tmp/publikator-full.tgz;type=application/gzip' \
  "http://127.0.0.1:${PORT}/api/backup-bundles/restore-upload" | \
  jq -e '.ok == true and .restart == true and (.preRestoreBackup.name | contains("pre-restore"))' >/dev/null

RESTORED=0
for _ in $(seq 1 60); do
  RESTART_AFTER="$(docker inspect -f '{{.RestartCount}}' "$CONTAINER_NAME" 2>/dev/null || echo 0)"
  if [ "$RESTART_AFTER" -gt "$RESTART_BEFORE" ] && curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    RESTORED=1
    break
  fi
  sleep 1
done
if [ "$RESTORED" != "1" ]; then
  docker logs "$CONTAINER_NAME"
  exit 1
fi

login
curl -fsS -b "$COOKIE_FILE" "http://127.0.0.1:${PORT}/api/projects" | jq -e --arg id "$EXTRA_PROJECT_ID" 'all(.[]; .id != $id)' >/dev/null
EXTRA_POST_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE_FILE" "http://127.0.0.1:${PORT}/api/posts/${EXTRA_POST_ID}")"
test "$EXTRA_POST_STATUS" = "404"
EXTRA_MEDIA_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/public-media/${EXTRA_MEDIA_PATH}")"
test "$EXTRA_MEDIA_STATUS" = "404"

curl -fsS -b "$COOKIE_FILE" "http://127.0.0.1:${PORT}/api/posts/${POST_ID}" | \
  jq -e --arg first "$MEDIA_2" '.status == "READY" and .content_version >= 1 and (.ready_revision_id != null) and (.media | length) == 2 and .media[0].id == $first and any(.targets[]; .platform == "telegram" and .enabled == 1 and .override_text == "Telegram CI override")' >/dev/null
curl -fsS -b "$COOKIE_FILE" "http://127.0.0.1:${PORT}/api/backup-bundles" | jq -e 'any(.[]; .name | contains("pre-restore"))' >/dev/null

echo '{"ok":true,"productionDocker":true,"fullBackupRestore":true,"schemaVersion":5}'
