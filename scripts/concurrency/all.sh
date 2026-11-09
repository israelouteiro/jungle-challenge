#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

# Build once. Each script owns and removes its own database, queues and containers.
if [ "${CONCURRENCY_PREPARED:-0}" != 1 ]; then prepare_environment; fi
BATCH_REPORT="$ROOT/artifacts/concurrency/$(date +%s)-$$"
mkdir -p "$BATCH_REPORT"

for script in \
  01-duplicates.sh \
  02-competing-bets.sh \
  03-independent-wallets.sh \
  04-multiple-processes.sh \
  05-worker-crash.sh \
  06-concurrent-publishers.sh \
  07-out-of-order-reference.sh \
  08-restart.sh
do
  CONCURRENCY_PREPARED=1 CONCURRENCY_REPORT_DIR="$BATCH_REPORT/${script%.sh}" \
    "$SCRIPT_DIR/$script"
done

printf '\nOs oito cenários passaram. Evidências: %s\n' "$BATCH_REPORT"
