#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

initialize_scenario 03
printf '\n[03/08] Carteiras distintas em paralelo\n'
wallet
locked=$W; locked_player=$player
sql "BEGIN; SELECT id FROM wallets WHERE id='$locked' FOR NO KEY UPDATE; SELECT pg_sleep(4); COMMIT;" > "$REPORT/$tag-lock.log" & lockpid=$!; JOBS=$lockpid
wait_sql "SELECT count(*) FROM pg_stat_activity WHERE datname='$DB' AND query LIKE '%pg_sleep(4)%' AND wait_event='PgSleep'" 1
body=$(payload "$RUN-locked" BET 10.00)
http POST "$API1/wagering/transactions" "$body" "$RUN-locked" "$REPORT/$tag-locked" & JOBS="$JOBS $!"
wallet; other=$W; other_player=$player
body=$(payload "$RUN-independent" BET 10.00)
http POST "$API2/wagering/transactions" "$body" "$RUN-independent" "$REPORT/$tag-independent"
status "$REPORT/$tag-independent" 200
kill -0 "$lockpid" 2>/dev/null || fail 'Carteira distinta aguardou o lock da primeira'
join_jobs; status "$REPORT/$tag-locked" 200
reconcile 90.00 2
W=$locked; player=$locked_player; reconcile 90.00 2
printf '[OK] Carteiras distintas em paralelo: saldo reconciliado com o ledger\n'
