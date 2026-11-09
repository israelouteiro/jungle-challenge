#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

initialize_scenario 04
printf '\n[04/08] Três processos HTTP e três consumers\n'
sql "CREATE TABLE curl_inbox_audit (worker text, message_id text);
CREATE FUNCTION curl_audit_inbox() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN
INSERT INTO curl_inbox_audit VALUES (current_setting('application_name'),NEW.message_id); RETURN NEW; END \$\$;
CREATE TRIGGER curl_inbox_audit AFTER INSERT ON inbox FOR EACH ROW EXECUTE FUNCTION curl_audit_inbox();" >/dev/null

wallet
body=$(payload "$RUN-instances" BET 80.00); i=0
for api in "$API1" "$API2" "$API3"; do
  i=$((i+1)); http POST "$api/wagering/transactions" "$body" "$RUN-instances" "$REPORT/$tag-api$i" & JOBS="$JOBS $!"
done
join_jobs
for i in 1 2 3; do status "$REPORT/$tag-api$i" 200; done
reconcile 20.00 2
wallet
for i in 1 2 3; do start_worker "consumer$i"; done
wait_sql "SELECT count(DISTINCT application_name) FROM pg_stat_activity WHERE datname='$DB' AND application_name LIKE 'curl-$RUN-consumer%'" 3
for i in $(seq 1 24); do body=$(payload "$RUN-worker-$i" BET 1.00); send_command "$RUN-msg-$i" "$RUN-worker-$i" "$body"; done
wait_sql "SELECT count(*) FROM inbox WHERE message_id LIKE '$RUN-msg-%' AND processed_at IS NOT NULL" 24
wait_empty_incoming
[ "$(sql "SELECT count(DISTINCT worker) FROM curl_inbox_audit WHERE message_id LIKE '$RUN-msg-%'")" = 3 ] || fail 'Os três consumers não processaram mensagens'
for i in 1 2 3; do stop_worker "curl-$RUN-consumer$i"; done
reconcile 76.00 25
printf '[OK] Três processos HTTP e três consumers: saldo reconciliado com o ledger\n'
