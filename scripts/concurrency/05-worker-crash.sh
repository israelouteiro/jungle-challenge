#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

initialize_scenario 05
printf '\n[05/08] Worker morto após commit e antes do ack\n'
wallet
body=$(payload "$RUN-crash" BET 25.00)
start_worker crash afterCommit; crash=$name
send_command "$RUN-crash-msg" "$RUN-crash" "$body"
attempt=0
while [ "$(docker inspect -f '{{.State.Running}}' "$crash")" = true ]; do
  attempt=$((attempt+1)); [ "$attempt" -lt 30 ] || fail 'Failpoint não matou o worker'; sleep 1
done
[ "$(docker inspect -f '{{.State.ExitCode}}' "$crash")" = 137 ] || fail 'Esperado SIGKILL'
reconcile 75.00 2
count=$(sqs get-queue-attributes --queue-url "$INCOMING" --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible | jq '[.Attributes[]|tonumber]|add')
[ "$count" = 1 ] || fail 'Mensagem deveria aguardar ack/redelivery'
start_worker recovery; recovery=$name
wait_empty_incoming
stop_worker "$recovery"
http POST "$BASE/wagering/transactions" "$body" "$RUN-crash" "$REPORT/$tag-replay"
status "$REPORT/$tag-replay" 200; check "$REPORT/$tag-replay" '.idempotentReplay==true'
reconcile 75.00 2
printf '[OK] Worker morto após commit e antes do ack: saldo reconciliado com o ledger\n'
