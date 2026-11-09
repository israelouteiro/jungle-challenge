# Desenvolvimento e operação

[README](../README.md) · [Testes](./TESTING.md) · [Arquitetura](../ARCHITECTURE.md)

## Docker

Use o comando de inicialização do README também após alterar o código. As imagens
contêm uma cópia dos fontes; alterações locais exigem rebuild.

Acessos da API e inicialização: [README](../README.md). PostgreSQL atende em
`localhost:5432` (banco/usuário/senha: `jungle`); LocalStack em `localhost:4566`.
Execute ferramentas com `docker compose exec -T tools <comando>`.

O profile `app` inclui migrations, três réplicas quando usado `--scale app=3` e
Nginx na porta fixa 3000. O profile `tools` inclui Bun, fontes e oha. Sem profiles,
`docker compose up` inicia somente PostgreSQL e LocalStack.

O oha é baixado em uma etapa Docker independente, com versão e checksum fixados.
O primeiro build exige GitHub; falhas no download direto usam a
[API oficial de releases](https://docs.github.com/en/rest/releases/assets).

```sh
docker compose ps
docker compose logs --tail=100 app
```

Na rede Docker, use `http://app:3000`, `postgres:5432` e `http://localstack:4566`.
Para depurar uma réplica diretamente, consulte sua porta com
`docker compose port --index 1 app 3000`.

O volume do PostgreSQL persiste após `down`; as filas locais são efêmeras.
Relatórios em `artifacts/` ficam no host. Snapshots do MikroORM ficam em
`.snapshots/`; seu conteúdo é ignorado pelo Git e pelo build Docker.

## Bun no host

Alternativa ao ambiente completo em containers, com Bun 1.4.4 instalado:

```sh
bun install --frozen-lockfile
bun run infra:up
bun run migration:up
bun run start:dev
```

A API atende em `http://localhost:3000`. Se o gateway Docker já ocupar essa porta,
use `PORT=3001 bun run start:dev`. Copie `.env.example` para `.env` para personalizar
o ambiente; o Bun carrega esse arquivo automaticamente.

`start:dev` compila TypeScript antes de executar com Bun para preservar os metadados
de injeção do NestJS. Para build de produção, use `bun run build` e `bun run start`.
`migration:down` reverte a última migration e pode remover dados.

## API e Postman

Os contratos e exemplos das dez rotas estão no [apiDoc](http://localhost:3000/docs/).
O build gera a página a partir dos comentários dos controllers. Após editar as
anotações durante o desenvolvimento, execute `bun run docs:build`.

Importe a [collection](../postman/JungleGaming.postman_collection.json) e o
[ambiente](../postman/Local.postman_environment.json). Use
`baseUrl=http://localhost:3000` e **Run collection**, mantendo a ordem das pastas.

- **01 · Rotas documentadas:** dez endpoints; pode rodar sozinha.
- **02 · Cenários funcionais:** 62 requisições. As quatro primeiras subpastas
  formam um fluxo; as duas últimas são independentes.

Use o Runner com workers ativos: referências pendentes consultam até 30 vezes,
a cada 1 s. Cada execução cria novos IDs e preserva o ledger. Concorrência, SQS
e recuperação são validados separadamente no [guia de testes](./TESTING.md).

Para executar a collection dentro do Docker:

```sh
docker compose exec -T tools bunx --bun newman@6.2.1 run postman/JungleGaming.postman_collection.json --env-var baseUrl=http://app:3000 --bail --reporters cli,json --reporter-json-export artifacts/postman/newman-report.json
```

Para executar apenas as rotas, acrescente `--folder '01 · Rotas documentadas'`.
O Newman é baixado no cache do Bun na primeira execução. O relatório fica em
`artifacts/postman/`. Após editar a collection, reconstrua `tools` para incluir a
versão atual no container.

## SQS

Os workers iniciam junto da API. A entrada recebe `WagerTransactionRequested`;
`data` usa o contrato HTTP com `idempotencyKey` adicional. Use `MessageGroupId`
igual a `walletId` e um `MessageDeduplicationId` próprio.

```sh
docker compose exec -T localstack awslocal sqs list-queues
```

As filas são `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e
`wagering-events.fifo`. Para executar somente HTTP no host, defina
`WORKERS_ENABLED=false`.

## Observabilidade

Ative traces nas réplicas e em `tools`, incluindo Jaeger, Prometheus e Grafana:

```sh
OTEL_ENABLED=true docker compose --profile app --profile tools --profile observability up -d --build --wait --scale app=3
```

- Jaeger: [localhost:16686](http://localhost:16686).
- Dashboard: [localhost:3001/d/wagering-overview](http://localhost:3001/d/wagering-overview).
- Controle de demonstração/carga e logs ao vivo: [localhost:3002](http://localhost:3002).
- Prometheus / targets: [localhost:9090/targets](http://localhost:9090/targets).
- Métricas Prometheus: [localhost:3000/metrics](http://localhost:3000/metrics).
- Logs JSON: `docker compose logs --tail=100 app`.

Tracing é opcional e desativado por padrão. No host, suba o serviço `jaeger` e use
`OTEL_ENABLED=true bun run start:dev`. O endpoint OTLP/HTTP JSON padrão é
`http://localhost:4318/v1/traces`; dentro do Docker, `http://jaeger:4318/v1/traces`.
`OTEL_SERVICE_NAME` define o serviço e `OTEL_TRACES_SAMPLER_ARG` a amostragem de
novos traces entre 0 e 1. O parent remoto é respeitado.

Métricas financeiras e backlog/idade da outbox são globais: agregue com `max` entre
réplicas. Some contadores operacionais por processo. OTLP exporta somente traces;
métricas permanecem em `/metrics` e logs em stdout.

Prometheus descobre as réplicas pelo DNS `app` e coleta cada IP a cada 1 s,
sem passar pelo gateway. Grafana provisiona o datasource e o dashboard automaticamente;
a visualização local não exige login. As portas 3001, 3002 e 9090 ficam restritas ao host.
O histórico fica em volumes Docker, com retenção de 7 dias no Prometheus.

Contadores operacionais reiniciam com o processo. O p95 é estimado por buckets,
exige tráfego e duas coletas; pode ficar vazio sem atividade. Backlogs breves podem
não aparecer. “Envios à DLQ” não mede profundidade nem redrive nativo.

O painel de controle aceita somente demonstração/carga com limites fixos e uma
execução por vez. Exige mesma origem, usa SSE para logs e não acessa o socket Docker.
Grafana permite embedding local. Esse serviço é separado das dez rotas da API.

Configuração em `infra/observability/`, seguindo o
[provisionamento do Grafana](https://grafana.com/docs/grafana/latest/administration/provisioning/)
e a [descoberta DNS do Prometheus](https://prometheus.io/docs/prometheus/latest/configuration/configuration/#dns_sd_config).
