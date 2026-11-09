#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

initialize_scenario 08
printf '\n[08/08] Reinício e consistência final\n'
wallet
body=$(payload "$RUN-restart" BET 80.00)
http POST "$API1/wagering/transactions" "$body" "$RUN-restart" "$REPORT/$tag-before"
status "$REPORT/$tag-before" 200
reconcile 20.00 2
docker restart -t 15 "$C1" >/dev/null
# Docker may allocate another host port when restarting a dynamic mapping.
port=$(docker port "$C1" 3000/tcp | sed 's/.*://')
API1="http://127.0.0.1:$port"; BASE=$API1
wait_ready "$API1"
http POST "$API1/wagering/transactions" "$body" "$RUN-restart" "$REPORT/$tag-after"
status "$REPORT/$tag-after" 200; check "$REPORT/$tag-after" '.idempotentReplay==true'
[ "$(jq -r .transactionId "$REPORT/$tag-before.json")" = "$(jq -r .transactionId "$REPORT/$tag-after.json")" ] || fail 'Resultado mudou após reinício'
reconcile 20.00 2
printf '[OK] Reinício e consistência final: saldo reconciliado com o ledger\n'
