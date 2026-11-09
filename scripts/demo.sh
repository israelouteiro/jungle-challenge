#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
command -v docker >/dev/null 2>&1 || { echo 'Instale Docker com Compose v2.' >&2; exit 1; }
OTEL_ENABLED=true docker compose --profile app --profile tools --profile observability up -d --build --wait --scale app=3
docker compose kill -s SIGHUP prometheus
docker compose exec -T presentation bun scripts/presentation/cli.ts
printf '\nControle de testes: http://localhost:3002\nDashboard: http://localhost:3001/d/wagering-overview\nTraces: http://localhost:16686\n'
