#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

initialize_scenario 06
printf '\n[06/08] Dois publishers concorrentes\n'
sql "CREATE TABLE curl_publish_audit (worker text, event_id uuid);
CREATE FUNCTION curl_audit_publish() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN
IF OLD.published_at IS NULL AND NEW.published_at IS NOT NULL THEN
PERFORM pg_sleep(0.02); INSERT INTO curl_publish_audit VALUES (current_setting('application_name'),NEW.id); END IF;
RETURN NEW; END \$\$;
CREATE TRIGGER curl_publish_audit AFTER UPDATE ON outbox FOR EACH ROW EXECUTE FUNCTION curl_audit_publish();" >/dev/null
wallet
# Audit only this disposable database; slow each confirmation so both publishers claim batches.
sql 'TRUNCATE curl_publish_audit' >/dev/null
for i in $(seq 1 30); do
  body=$(payload "$RUN-publish-$i" WIN 1.00)
  http POST "$BASE/wagering/transactions" "$body" "$RUN-publish-$i" "$REPORT/$tag-$i" & JOBS="$JOBS $!"
done
join_jobs
for i in $(seq 1 30); do status "$REPORT/$tag-$i" 200; done
start_worker publisher1; pub1=$name
start_worker publisher2; pub2=$name
wait_sql 'SELECT count(*) FROM outbox WHERE published_at IS NULL' 0
[ "$(sql "SELECT count(DISTINCT worker) FROM curl_publish_audit WHERE worker IN ('$pub1','$pub2')")" = 2 ] || fail 'Os dois publishers não confirmaram eventos'
[ "$(sql 'SELECT count(*)-count(DISTINCT event_id) FROM curl_publish_audit')" = 0 ] || fail 'Confirmação duplicada de outbox'
sql 'SELECT worker,count(*) FROM curl_publish_audit GROUP BY worker' > "$REPORT/$tag-publishers.txt"
stop_worker "$pub1"; stop_worker "$pub2"
sql 'SELECT id FROM outbox ORDER BY id' > "$REPORT/$tag-expected-events.txt"
: > "$REPORT/$tag-received-events.txt"
attempt=0
while ! cmp -s "$REPORT/$tag-expected-events.txt" "$REPORT/$tag-received-events.txt"; do
  attempt=$((attempt+1)); [ "$attempt" -lt 90 ] || fail 'Eventos confirmados ausentes no SQS'
  batch=$(sqs receive-message --queue-url "$EVENTS" --max-number-of-messages 10 --wait-time-seconds 1)
  [ -n "$batch" ] || batch='{}'
  printf '%s' "$batch" > "$REPORT/$tag-events-$attempt.json"
  printf '%s' "$batch" | jq -r '.Messages[]? | .Body | fromjson | .eventId' >> "$REPORT/$tag-received-events.txt"
  sort -u "$REPORT/$tag-received-events.txt" > "$REPORT/$tag-sorted.txt"
  mv "$REPORT/$tag-sorted.txt" "$REPORT/$tag-received-events.txt"
  entries=$(printf '%s' "$batch" | jq -c '[.Messages // [] | to_entries[] | {Id:(.key|tostring),ReceiptHandle:.value.ReceiptHandle}]')
  if [ "$entries" != '[]' ]; then
    sqs delete-message-batch --queue-url "$EVENTS" --entries "$entries" > "$REPORT/$tag-delete-$attempt.json"
    jq -e '(.Failed // [])|length==0' "$REPORT/$tag-delete-$attempt.json" >/dev/null || fail 'Falha ao confirmar leitura de eventos'
  fi
done
reconcile 130.00 31
printf '[OK] Dois publishers concorrentes: saldo reconciliado com o ledger\n'
