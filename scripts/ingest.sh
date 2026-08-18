#!/usr/bin/env bash
# ponytail: tafrigh's *.chunks.ndjson is already index-ready — curl beats a TS client.
# Rewrite in TS when articles/playlists need shaping at ingest time.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

api() { curl -fsS -H "Authorization: Bearer $MEILI_ADMIN_KEY" "$@"; }

wait_task() {
  local uid=$1 status
  while :; do
    status=$(api "$MEILI_HOST/tasks/$uid" | jq -r .status)
    case $status in
      succeeded) return 0 ;;
      failed|canceled) api "$MEILI_HOST/tasks/$uid" | jq .error; return 1 ;;
      *) sleep 1 ;;
    esac
  done
}

# index + settings (idempotent; POST /indexes 409s if it already exists)
api -X POST "$MEILI_HOST/indexes" -H 'Content-Type: application/json' \
  -d '{"uid":"cues","primaryKey":"id"}' >/dev/null 2>&1 || true
wait_task "$(api -X PATCH "$MEILI_HOST/indexes/cues/settings" \
  -H 'Content-Type: application/json' \
  --data-binary @meilisearch-settings.json | jq -r .taskUid)"

# documents — same id overwrites, so re-running after new videos is safe
cat "$RAW_DIR"/*.chunks.ndjson > /tmp/cues.ndjson
echo "ingesting $(wc -l < /tmp/cues.ndjson | tr -d ' ') cues from $RAW_DIR"
wait_task "$(api -X POST "$MEILI_HOST/indexes/cues/documents?primaryKey=id" \
  -H 'Content-Type: application/x-ndjson' \
  --data-binary @/tmp/cues.ndjson | jq -r .taskUid)"

api "$MEILI_HOST/indexes/cues/stats" | jq '{numberOfDocuments}'
