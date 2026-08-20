#!/usr/bin/env bash
# The four Better Stack monitors and the heartbeat, as a recipe rather than as clicks.
#
#   BETTERSTACK_API_TOKEN=… SEARCH_KEY=… ops/monitors.sh
#
# SEARCH_KEY is the public search key that already ships inside the JS bundle (`pnpm index`
# prints it), so nothing secret lives in this file. Re-running is safe: anything already
# there under the same name is left alone — edit monitors in the dashboard, not here.
set -euo pipefail
: "${BETTERSTACK_API_TOKEN:?get one at Better Stack → Settings → API tokens}"
: "${SEARCH_KEY:?the public Meilisearch search key}"
SITE=${SITE:-https://alkulify.assoli.site}
SEARCH=${SEARCH:-https://search.assoli.site}
API=https://uptime.betterstack.com/api/v2

api() {  # method path [body]
  local args=(-fsS -X "$1" "$API/$2" -H "Authorization: Bearer $BETTERSTACK_API_TOKEN"
              -H 'Content-Type: application/json')
  [ $# -ge 3 ] && args+=(--data "$3")   # an array, because the query has a space in it
  curl "${args[@]}"
}

# Free plan: 10 monitors, 3-minute checks.
mon() {  # name url keyword [method] [body] [timeout]
  if grep -qxF "$1" <<<"$existing"; then echo "= $1"; return; fi
  api POST monitors "$(jq -nc \
      --arg name "$1" --arg url "$2" --arg kw "$3" --arg method "${4:-GET}" \
      --arg body "${5:-}" --arg key "$SEARCH_KEY" --argjson timeout "${6:-15}" '
    {monitor_type: "keyword", pronounceable_name: $name, url: $url, required_keyword: $kw,
     http_method: $method, check_frequency: 180, request_timeout: $timeout,
     email: true, push: true}
    + (if $body == "" then {} else
        {request_body: $body,
         request_headers: [{name: "Content-Type", value: "application/json"},
                           {name: "Authorization", value: "Bearer \($key)"}]}
       end)')" | jq -r '"+ \(.data.attributes.pronounceable_name) (#\(.data.id))"'
}

existing=$(api GET 'monitors?per_page=50' | jq -r '.data[].attributes.pronounceable_name')

mon 'kashaf site'              "$SITE/"                     'كشّاف'
mon 'meilisearch health'       "$SEARCH/health"             'available'
mon 'kashaf search (keyword)'  "$SEARCH/indexes/cues/search" 'video_id' POST \
    "$(jq -nc '{q: "كفارة اليمين", hitsPerPage: 1}')"
mon 'kashaf search (hybrid)'   "$SEARCH/multi-search"        'video_id' POST \
    "$(jq -nc '{queries: [{indexUid: "cues", q: "كفارة اليمين", hitsPerPage: 1,
                           hybrid: {embedder: "default", semanticRatio: 0.5}}]}')" 30

# The box beats every 10 minutes; one missed beat is forgiven, two raise an incident.
if api GET heartbeats | jq -e --arg n 'kashaf box' '.data[] | select(.attributes.name == $n)' >/dev/null; then
  echo '= kashaf box'
else
  api POST heartbeats "$(jq -nc '{name: "kashaf box", period: 600, grace: 300,
                                  email: true, push: true}')" \
    | jq -r '"+ kashaf box → HEARTBEAT_URL=\(.data.attributes.url)"'
fi
