#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

initialize_scenario 02
printf '\n[02/08] Duas apostas de 80 disputando saldo de 100\n'
wallet
a=$(payload "$RUN-bet-a" BET 80.00); b=$(payload "$RUN-bet-b" BET 80.00)
http POST "$API1/wagering/transactions" "$a" "$RUN-bet-a" "$REPORT/$tag-a" & JOBS="$!"
http POST "$API2/wagering/transactions" "$b" "$RUN-bet-b" "$REPORT/$tag-b" & JOBS="$JOBS $!"
join_jobs
case "$(cat "$REPORT/$tag-a.status"):$(cat "$REPORT/$tag-b.status")" in
  200:422|422:200) : ;; *) fail 'Esperados HTTP 200 e 422 na disputa' ;;
esac
jq -se '([.[]|select(.status=="PROCESSED")]|length)==1 and ([.[]|select(.status=="REJECTED" and .failureCode=="INSUFFICIENT_FUNDS")]|length)==1' "$REPORT/$tag-a.json" "$REPORT/$tag-b.json" >/dev/null || fail 'Disputa por saldo'
http POST "$API3/wagering/transactions" "$a" "$RUN-bet-a" "$REPORT/$tag-retry-a"
http POST "$API3/wagering/transactions" "$b" "$RUN-bet-b" "$REPORT/$tag-retry-b"
check "$REPORT/$tag-retry-a" '.idempotentReplay==true'; check "$REPORT/$tag-retry-b" '.idempotentReplay==true'
reconcile 20.00 2
check "$REPORT/$tag-ledger" '[.items[]|select(.direction=="DEBIT")]|length==1'
printf '[OK] Duas apostas de 80 disputando saldo de 100: saldo reconciliado com o ledger\n'
