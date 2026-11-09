#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

initialize_scenario 01
printf '\n[01/08] 50 duplicatas, um único débito\n'
wallet
body=$(payload "$RUN-dup" BET 80.00)
for i in $(seq 1 50); do
  http POST "$BASE/wagering/transactions" "$body" "$RUN-dup" "$REPORT/$tag-$i" & JOBS="$JOBS $!"
done
join_jobs
for i in $(seq 1 50); do status "$REPORT/$tag-$i" 200; done
jq -se '([.[].transactionId]|unique|length)==1 and ([.[]|select(.idempotentReplay==false)]|length)==1' "$REPORT/$tag-"[0-9]*.json >/dev/null || fail 'Duplicação financeira'
reconcile 20.00 2
printf '[OK] 50 duplicatas, um único débito: saldo reconciliado com o ledger\n'
