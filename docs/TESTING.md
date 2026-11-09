# Testes e carga

[README](../README.md) · [Desenvolvimento](./DEVELOPMENT.md) · [Arquitetura](../ARCHITECTURE.md)

## Suíte automatizada

Com o ambiente do README ativo:

```sh
docker compose exec -T tools bun run test:all
```

Verifica formatação, tipos, 59 testes unitários e 32 de integração. A integração
compila a aplicação e gera/valida apiDoc, comparando as dez rotas com os controllers.

Banco e três filas exclusivos são criados por execução e removidos ao terminar.
As réplicas existentes continuam ativas. Os cenários de concorrência iniciam seus
próprios processos NestJS, compartilhando o banco isolado. PostgreSQL e SQS são
reais; o usuário de teste precisa de CREATE DATABASE.

A cobertura inclui dinheiro exato, disputa por saldo, 50 duplicatas concorrentes,
carteiras independentes, referências fora de ordem, inbox/outbox atômicas, constraints,
migrations up/down/up, publishers/consumers concorrentes, SIGTERM, SIGKILL após
commit/envio, retries, FAILED/DLQ, redrive nativo e tracing OTLP.

Para executar partes separadas, use `bun run typecheck`, `bun run test` ou
`bun run test:integration` dentro de `tools`. No host com Bun e infraestrutura
ativa, os mesmos scripts funcionam diretamente.

## Concorrência — item 13

Execute todos os cenários em sequência, parando na primeira falha:

```sh
./scripts/concurrency/all.sh
```

Requisitos no host: Docker Compose v2, `curl` e `jq`. Cada script contém as chamadas
e validações do seu cenário e cria três containers da API, banco e filas próprios.
Não chama `bun test` nem fixtures. As réplicas já existentes permanecem ativas;
os recursos temporários são removidos ao terminar, inclusive em caso de falha.

Também é possível executar um cenário individualmente:

| Script em `scripts/concurrency/` | Cenário                              |
| -------------------------------- | ------------------------------------ |
| `01-duplicates.sh`               | 50 duplicatas e um débito            |
| `02-competing-bets.sh`           | Duas apostas de 80 sobre saldo 100   |
| `03-independent-wallets.sh`      | Carteiras distintas em paralelo      |
| `04-multiple-processes.sh`       | Três processos HTTP e três consumers |
| `05-worker-crash.sh`             | Morte após commit e antes do ack     |
| `06-concurrent-publishers.sh`    | Dois publishers na mesma outbox      |
| `07-out-of-order-reference.sh`   | REFUND antes da BET                  |
| `08-restart.sh`                  | Reinício da API e consistência final |

As chamadas HTTP usam `curl`; `jq` valida status, IDs, saldo e reconciliação.
Requisições concorrentes rodam em processos shell em background com `wait`.
O cenário de carteiras independentes mantém um lock SQL na primeira e verifica
que a segunda responde antes da liberação desse lock.

Os cenários de mensageria usam também `awslocal` e `psql` dentro dos containers:
três consumers precisam deixar evidência de processamento; dois publishers precisam
confirmar eventos distintos. Os IDs recebidos no SQS são comparados com os da outbox.
Essa auditoria existe apenas no banco descartável e
inclui uma pausa curta para tornar a disputa dos publishers observável, sem medir
desempenho. No cenário de crash, o failpoint `afterCommit` (somente `NODE_ENV=test`)
provoca SIGKILL no worker real antes do ack; outro worker recupera a mensagem.
Somente os containers criados pelo script são reiniciados ou encerrados.

Cada cenário confere `wallet.balance` contra o ledger via reconciliação. Respostas,
códigos HTTP e logs ficam em `artifacts/concurrency/<execução>/`. O executor geral constrói a imagem uma vez e separa as evidências por cenário.

## Carga isolada com Bun e oha

```sh
docker compose exec -T -e LOAD_REQUESTS=1000 -e LOAD_CONCURRENCY=20 tools bun run test:load
```

Bun cria banco/filas temporários e três processos NestJS dentro de `tools`, com
workers ativos. As réplicas Compose não precisam parar. Os processos de carga
compartilham os recursos de um container. Relatórios ficam em `artifacts/load/`
no host; oha 1.16.0 já está instalado na imagem com checksum verificado.

Após 20 operações de aquecimento, o experimento executa:

| Ferramenta | Cenários                                                               | Validação                                    |
| ---------- | ---------------------------------------------------------------------- | -------------------------------------------- |
| Bun        | Carteiras independentes, hot wallet, replays, apostas disputando saldo | Corpos, saldo exato, ledger e reconciliação  |
| oha        | Consulta de carteira, consulta do ledger, replay HTTP                  | Status, duplicatas e reconciliação posterior |

Percentis de cada ferramenta permanecem separados. Oha usa corpo/chave estáticos
para replay; operações únicas e verificações por resposta ficam no Bun. Respostas
422 esperadas por saldo insuficiente não contam como erros inesperados.

| Variável                | Padrão          | Uso                                           |
| ----------------------- | --------------- | --------------------------------------------- |
| `LOAD_REQUESTS`         | 100             | Requisições por cenário                       |
| `LOAD_CONCURRENCY`      | 10              | Clientes simultâneos                          |
| `LOAD_P95_MS`           | 5000            | Teto de p95 em ms                             |
| `LOAD_SAMPLE_MS`        | 500             | Intervalo entre coletas em ms                 |
| `LOAD_DRAIN_TIMEOUT_MS` | 60000           | Prazo de drenagem após a carga em ms          |
| `LOAD_WORKERS`          | true            | false desativa workers no experimento isolado |
| `LOAD_ENVIRONMENT`      | descrição local | Contexto adicional do ambiente                |

Falhas inesperadas, divergência financeira, erro de monitoramento/worker, p95
acima do teto ou ausência de drenagem no prazo retornam exit code 1. O relatório
inclui ambiente, latências, erros, conflitos SQL, duplicatas, backlog/idade e drenagem.
Conflitos SQL não incluem esperas normais por lock; picos de backlog são amostrados.

No host, instale o binário uma vez com `bun run load:install` e execute
`LOAD_REQUESTS=1000 LOAD_CONCURRENCY=20 bun run test:load`. O instalador suporta
macOS/Linux arm64/x64 e grava em `.tools/`; `OHA_BIN` permite usar um binário existente.

## Carga nas três réplicas Compose

Para endereçar explicitamente cada container em um terminal POSIX:

```sh
APP_URLS=$(docker compose ps --format '{{.Name}}' app | awk 'NR>1 {printf ","} {printf "http://%s:3000", $0}')
docker compose exec -T -e "LOAD_URLS=$APP_URLS" -e LOAD_EXPECT_DRAIN=true -e LOAD_REQUESTS=1000 -e LOAD_CONCURRENCY=20 -e 'LOAD_ENVIRONMENT=Tres replicas Compose; gerador tools' tools bun run test:load
```

`LOAD_URLS` usa a infraestrutura existente e preserva os dados criados. Use somente
o ambiente local. `LOAD_EXPECT_DRAIN=true` exige que a outbox zere no prazo.
Para medir desempenho, execute sem outras cargas ou suítes concorrentes, pois
compartilham CPU/infraestrutura e podem interferir nos contadores.

## Medição histórica

A [medição de 08/11/2026](./load-results/LOAD_TEST_RESULTS.json), com
[saída nativa oha](./load-results/LOAD_TEST_OHA_RESULTS.json), executou 7.000
requisições sem erros inesperados: 1.000 por cenário, 20 clientes, banco novo,
três processos Bun no host Apple M4 (10 CPUs/16 GiB), PostgreSQL/LocalStack em Docker
e tracing a 100%. Publicou os 5.144 eventos esperados, com drenagem em 35,75 s.

Essa versão ainda pausava 200 ms entre lotes cheios. Seus resultados não representam
a implementação atual nem a execução em três containers. Os JSONs preservam
ambiente, percentis e verificações financeiras; percentis oha excluem conexões
que falharam, contabilizadas na taxa de erro.

## Drenagem contínua da outbox

Em 09/11/2026, a pausa entre lotes cheios foi removida. Cada publisher busca o
próximo lote assim que confirma 10 publicações. Lotes parciais, erros ou fila
vazia mantêm a espera de 200 ms; retries, locks, tamanho dos lotes e prazo de
drenagem de 60 s permanecem iguais.

Comparação local: 2.000 requisições por cenário, 50 clientes, três réplicas Docker,
tracing a 100% e sete cenários (14.000 chamadas, além da preparação/validação).
Mesmo host e parâmetros; execuções em momentos diferentes sobre banco persistente
com histórico crescente. Não é um benchmark controlado nem capacidade de produção.

| Medida                         | Antes                               | Depois                 |
| ------------------------------ | ----------------------------------- | ---------------------- |
| Resultado                      | Falhou por prazo de drenagem        | Aprovado               |
| Duração total                  | 80,63 s                             | 28,70 s                |
| Drenagem após o tráfego        | Não terminou em 60 s; 514 pendentes | 0,53 s; zero pendentes |
| Maior backlog amostrado        | 8.274 eventos                       | 3.450 eventos          |
| Maior idade amostrada          | 62,92 s                             | 5,62 s                 |
| Erros inesperados nas chamadas | 0                                   | 0                      |
| p95 da hot wallet              | 565,79 ms                           | 821,10 ms              |

A melhora foi na publicação e no tempo total, com aumento observado da latência
HTTP durante a drenagem contínua. O teto de p95 de 5 s foi mantido. Depois da
mudança, os contadores registraram 10.144 publicações, sem retries, conflitos SQL
ou erros de workers durante a execução. As verificações financeiras passaram;
a auditoria final do banco não encontrou divergências entre saldo e ledger.

Evidências: [antes](./load-results/OUTBOX_BEFORE.json) e
[depois](./load-results/OUTBOX_AFTER.json). Os relatórios preservam parâmetros,
ambiente, percentis de cada cenário e amostras do backlog.

As medições usam modelo fechado e incluem monitoramento/tracing. Não comprovam
capacidade sustentável, chegada constante, ingestão SQS ou resistência prolongada.
