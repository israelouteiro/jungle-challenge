#!/bin/sh
# Shared environment lifecycle and HTTP/SQS/PostgreSQL helpers. No scenarios here.
set -eu
export COMPOSE_IGNORE_ORPHANS=true
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"

prepare_environment() {
  for dependency in docker curl jq; do
    command -v "$dependency" >/dev/null || { echo "Dependência ausente: $dependency" >&2; exit 1; }
  done
  docker compose up -d --wait postgres localstack
  docker compose --profile app build app
}

sql() { docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U jungle -d "$DB" -Atc "$1"; }
sqs() { docker compose exec -T localstack awslocal sqs "$@"; }
fail() { echo "FALHA: $* (evidências: $REPORT)" >&2; exit 1; }
cleanup() {
  result=$?
  trap - EXIT INT TERM
  for pid in $JOBS; do kill "$pid" 2>/dev/null || :; done
  for container in $CONTAINERS; do
    docker logs "$container" > "$REPORT/$container.log" 2>&1 || :
    docker rm -f "$container" >/dev/null 2>&1 || :
  done
  for queue in $QUEUES; do sqs delete-queue --queue-url "$queue" >/dev/null 2>&1 || :; done
  if [ "$DB_CREATED" = true ]; then
    docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U jungle -d jungle -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null || result=1
  fi
  echo "Evidências: $REPORT"
  exit "$result"
}
app_run() {
  docker compose -f compose.yaml -f scripts/concurrency/compose.yaml --profile app run --no-deps \
    -e "DATABASE_URL=postgresql://jungle:jungle@postgres:5432/$DB" \
    -e SQS_ENDPOINT=http://localstack:4566 \
    -e "SQS_QUEUE_URL=$INCOMING" -e "SQS_EVENTS_URL=$EVENTS" -e "SQS_DLQ_URL=$DLQ" \
    -e OTEL_ENABLED=false "$@"
}
start_api() {
  name="curl-$RUN-$1"
  CONTAINERS="$CONTAINERS $name"
  app_run -d --name "$name" -p '127.0.0.1::3000' -e WORKERS_ENABLED=false -e "INSTANCE_ID=$name" app >/dev/null
  port=$(docker port "$name" 3000/tcp | sed 's/.*://')
  url="http://127.0.0.1:$port"
  wait_ready "$url"
}
wait_ready() {
  attempt=0
  until curl -fsS --max-time 2 "$1/health/ready" >/dev/null 2>&1; do
    attempt=$((attempt+1)); [ "$attempt" -lt 60 ] || fail "Readiness: $1"; sleep 1
  done
}
http() (
  method=$1; endpoint=$2; body=$3; key=$4; output=$5
  if [ "$method" = GET ]; then
    curl -sS --connect-timeout 3 --max-time 20 -o "$output.json" -w '%{http_code}' "$endpoint" > "$output.status"
  else
    curl -sS --connect-timeout 3 --max-time 20 -X POST -H 'Content-Type: application/json' \
      -H "Idempotency-Key: $key" --data "$body" -o "$output.json" -w '%{http_code}' "$endpoint" > "$output.status"
  fi
)
status() { [ "$(cat "$1.status")" = "$2" ] || fail "HTTP esperado $2 em $1"; }
check() { jq -e "$2" "$1.json" >/dev/null || fail "Resposta inválida: $1: $2"; }
wallet() {
  player=$(sql 'SELECT gen_random_uuid()')
  http POST "$BASE/wallets" "{\"playerId\":\"$player\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}" '' "$REPORT/$tag-wallet"
  status "$REPORT/$tag-wallet" 201
  W=$(jq -er .id "$REPORT/$tag-wallet.json")
}
payload() {
  jq -nc --arg w "$W" --arg p "$player" --arg id "$1" --arg kind "$2" --arg amount "$3" --arg ref "${4:-}" \
    '{providerId:"curl-validation",externalTransactionId:$id,walletId:$w,playerId:$p,roundId:"round",gameId:"game",kind:$kind,money:{amount:$amount,currency:"BRL"}} + (if $ref == "" then {} else {referenceExternalTransactionId:$ref} end)'
}
reconcile() {
  http POST "$BASE/wallets/$W/reconciliation" '{}' '' "$REPORT/$tag-reconciliation"
  status "$REPORT/$tag-reconciliation" 200
  check "$REPORT/$tag-reconciliation" ".consistent == true and .storedBalance.amount == \"$1\" and .calculatedBalance.amount == \"$1\" and .checkedEntries == $2"
  http GET "$BASE/wallets/$W/ledger?limit=100" '' '' "$REPORT/$tag-ledger"
  status "$REPORT/$tag-ledger" 200
}
join_jobs() {
  failed=false
  for pid in $JOBS; do wait "$pid" || failed=true; done
  JOBS=''
  [ "$failed" = false ] || fail 'Uma chamada paralela falhou'
}
start_worker() {
  name="curl-$RUN-$1"; CONTAINERS="$CONTAINERS $name"
  point=${2:-none}
  app_run -d --name "$name" -e WORKERS_ENABLED=true -e NODE_ENV=test -e "FAILPOINT=$point" -e "INSTANCE_ID=$name" app >/dev/null
  docker inspect "$name" > "$REPORT/$name-inspect.json"
}
stop_worker() { docker stop -t 15 "$1" >/dev/null; }
wait_sql() {
  attempt=0
  until [ "$(sql "$1")" = "$2" ]; do
    attempt=$((attempt+1)); [ "$attempt" -lt 60 ] || fail "Timeout SQL: $1"; sleep 1
  done
}
send_command() {
  envelope=$(jq -nc --arg id "$1" --arg key "$2" --argjson data "$3" \
    '{messageId:$id,type:"WagerTransactionRequested",occurredAt:(now|todateiso8601),data:($data+{idempotencyKey:$key})}')
  sqs send-message --queue-url "$INCOMING" --message-body "$envelope" --message-group-id "$1" --message-deduplication-id "$1" >/dev/null
}
wait_empty_incoming() {
  attempt=0
  while :; do
    count=$(sqs get-queue-attributes --queue-url "$INCOMING" --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible | jq '[.Attributes[]|tonumber]|add')
    [ "$count" = 0 ] && break
    attempt=$((attempt+1)); [ "$attempt" -lt 30 ] || fail 'Mensagem não recebeu ack'; sleep 1
  done
}

initialize_scenario() {
  tag=$1
  if [ "${CONCURRENCY_PREPARED:-0}" != 1 ]; then prepare_environment; fi
  RUN=$(date +%s)-$$
  DB=curl_$(date +%s)_$$
  REPORT=${CONCURRENCY_REPORT_DIR:-"$ROOT/artifacts/concurrency/$RUN"}
  mkdir -p "$REPORT"
  CONTAINERS=''
  QUEUES=''
  JOBS=''
  DB_CREATED=false
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U jungle -d jungle -c "CREATE DATABASE $DB" >/dev/null
  DB_CREATED=true
  for kind in incoming events dlq; do
    queue=$(sqs create-queue --queue-name "curl-$RUN-$kind.fifo" --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"true"}' | jq -er '.QueueUrl | sub("https?://[^/]+"; "http://localstack:4566")')
    QUEUES="$QUEUES $queue"
    case "$kind" in incoming) INCOMING=$queue ;; events) EVENTS=$queue ;; dlq) DLQ=$queue ;; esac
  done
  app_run --rm app bun dist/infrastructure/database/migrate.js
  start_api api1; API1=$url; C1=$name
  start_api api2; API2=$url
  start_api api3; API3=$url
  BASE=$API1
}
