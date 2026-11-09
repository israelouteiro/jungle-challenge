#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

initialize_scenario 07
printf '\n[07/08] REFUND antes da referência\n'
wallet
refund=$(payload "$RUN-refund" REFUND 80.00 "$RUN-reference")
http POST "$BASE/wagering/transactions" "$refund" "$RUN-refund" "$REPORT/$tag-pending"
status "$REPORT/$tag-pending" 202; check "$REPORT/$tag-pending" '.status=="PENDING_REFERENCE"'
id=$(jq -er .transactionId "$REPORT/$tag-pending.json")
body=$(payload "$RUN-reference" BET 80.00)
http POST "$API2/wagering/transactions" "$body" "$RUN-reference" "$REPORT/$tag-bet"
status "$REPORT/$tag-bet" 200
start_worker reference; worker=$name
wait_sql "SELECT count(*) FROM wager_transactions WHERE id='$id' AND status='PROCESSED'" 1
stop_worker "$worker"
http POST "$API3/wagering/transactions" "$refund" "$RUN-refund" "$REPORT/$tag-replay"
status "$REPORT/$tag-replay" 200; check "$REPORT/$tag-replay" '.idempotentReplay==true'
reconcile 100.00 3
printf '[OK] REFUND antes da referência: saldo reconciliado com o ledger\n'
