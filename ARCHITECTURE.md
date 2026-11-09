# Arquitetura e decisões

[README](./README.md) · [Desenvolvimento](./docs/DEVELOPMENT.md) · [Testes](./docs/TESTING.md)

## Camadas e execução

Monólito modular NestJS. HTTP e SQS chamam o mesmo caso de uso `ProcessWager`.
O domínio não depende de NestJS ou MikroORM; a aplicação depende de portas para
transações e consultas. `AppModule` conecta essas portas aos adaptadores.

As camadas são `domain` (regras), `application` (casos de uso/portas),
`infrastructure` (PostgreSQL/SQS), `http` (contratos) e `observability`.
Cada réplica executa HTTP e quatro workers: consumer, publisher, resolução de
referências e auditoria da DLQ. Nginx resolve as réplicas pelo DNS do Docker.

## Dinheiro e ledger

`Money` usa decimal.js com precisão 48. PostgreSQL armazena `NUMERIC(20,2)` mapeado
como string. Entrada e saída exigem duas casas (`"25.00"`), sem arredondamento ou
conversão para `number`. Valores negativos de entrada, números JSON e moedas
inválidas são rejeitados; não há conversão entre moedas.

BET debita; WIN credita; LOSS não movimenta saldo. REFUND e ROLLBACK são integrais.
Abertura positiva gera OPENING, ledger e eventos; abertura zero não gera lançamento.
A versão da carteira começa em 1 e aumenta quando o saldo muda.

Constraints e triggers garantem saldo não negativo, identidade/moeda imutáveis,
unicidade da carteira por jogador/moeda, versão consistente e um lançamento por
carteira/transação. O ledger rejeita UPDATE, DELETE e TRUNCATE. Triggers diferidas
conferem no commit saldo reconstruído e correspondência entre transação e ledger.
Reconciliação usa leitura protegida por lock e informa divergências sem corrigi-las.

## Atomicidade e concorrência

Cada operação usa um EntityManager isolado e uma única transação SQL para inbox,
transação financeira, carteira, ledger, resultado e outbox. Falha em qualquer etapa
reverte o conjunto. Repositórios compartilham o EntityManager transacional;
entidades do ORM ficam restritas à infraestrutura.

A carteira é bloqueada com `FOR NO KEY UPDATE` antes da leitura autoritativa do
saldo. Esse lock permite o `KEY SHARE` das FKs e evita upgrades de lock entre
operações concorrentes. Carteiras distintas não compartilham lock global.
Unicidade e locks no PostgreSQL protegem também requisições em processos distintos.

Timeout/deadlock causa rollback: HTTP retorna 503 e SQS tenta novamente.
O cliente HTTP pode reenviar com a mesma chave. Lock timeout padrão: 5 s
(`PG_LOCK_TIMEOUT_MS`, de 1 a 60000 ms); statement: 10 s; conexão: 3 s.

## Idempotência

`Idempotency-Key` é obrigatória e global; `providerId/externalTransactionId` também
é único. Um INSERT condicional reserva a operação e um lock serializa duplicatas.
SHA-256 do JSON canônico compara os campos de negócio normalizados; metadados de
transporte não entram no hash. UUIDs são normalizados antes dessa comparação.

O resultado é persistido junto do movimento. Repetições retornam o resultado
original, incluindo saldo histórico; corpo divergente retorna 409. Inbox deduplica
por consumidor/messageId e verifica o hash. Novos IDs de transporte continuam
protegidos pela chave de negócio.

## Referências e estados

Estados terminais são `PROCESSED`, `REJECTED` e `FAILED`. Referência ausente ou
pendente mantém `PENDING_REFERENCE`; a resolução retorna o estado mais recente.
Depois do resultado terminal, não há nova aplicação financeira.

- WIN/LOSS podem referenciar BET processada, com valor independente.
- REFUND exige BET; ROLLBACK admite BET, WIN ou REFUND e inverte sua direção.
- A referência deve ter o mesmo provedor, jogador, carteira, moeda e rodada.
  `gameId` é registrado, mas não participa dessa igualdade, conforme o enunciado.
- Há uma reversão processada por referência **e tipo**. Assim, a mesma BET pode
  receber um REFUND e um ROLLBACK; essa interpretação deve ser confirmada com o
  negócio antes de produção. ROLLBACK de ROLLBACK é proibido.

Referências são reprocessadas com backoff de 2 s, 4 s, 8 s, até o teto de 1 h,
limitado a 10 retries ou 24 h desde a criação. Ao esgotar, retorna
`REJECTED/REFERENCE_NOT_FOUND`. Elegibilidade e prazo são conferidos sob lock,
impedindo workers concorrentes de anteciparem retries.

Regras de negócio geram REJECTED. Violações internas de invariantes causam rollback
e falha de processamento, sem serem convertidas em rejeições de negócio.
Os contratos e códigos de erro estão no apiDoc.

## Mensageria e recuperação

O consumer confirma a mensagem somente após o commit SQL. Visibilidade de 60 s é
renovada a cada 20 s. Falhas usam backoff de até 300 s; após cinco recebimentos,
comandos válidos são finalizados como `FAILED/INFRASTRUCTURE_RETRY_EXHAUSTED`, sem
movimentar saldo. A mensagem vai para DLQ antes de ser removida da origem.
Mensagens inválidas vão diretamente para DLQ; rejeições de negócio recebem ack.
Resultados já confirmados não são substituídos por falhas de transporte.

Se o redrive nativo ocorrer antes de gravar FAILED, o auditor tenta registrar o
resultado após a recuperação do banco. Consulta a DLQ a cada 30 s, preserva estados
existentes e mantém a mensagem para inspeção, invisível por 300 s após auditoria.

Publishers selecionam lotes de 10 com `FOR UPDATE SKIP LOCKED`, enviam para SQS e
só então confirmam `publishedAt`. Retry exponencial tem teto de 1 h, sem descartar
eventos. Crash após envio pode republicar o mesmo `eventId`: a entrega é
**at-least-once**. Consumidores externos precisam deduplicar esse ID; FIFO não
substitui deduplicação persistente. Não há ordem global de publicação;
`walletVersion` permite detectar lacunas e eventos fora de ordem.

Um lote com 10 publicações confirmadas dispara a próxima busca. A pausa de 200 ms fica para
lotes incompletos, fila vazia ou erro; não limita a drenagem de um backlog contínuo.

SIGTERM interrompe novos recebimentos e aguarda operações em andamento antes de
fechar SQS/banco e tracing. SIGKILL depende da visibilidade e da inbox para recuperar.
Failpoints de testes só funcionam com `NODE_ENV=test`.

## Observabilidade

Spans explícitos cobrem HTTP, unidade de trabalho SQL, consumer e publisher.
Contexto W3C é persistido na outbox e propagado via atributos SQS. Logs incluem
traceId/spanId; corpos, dinheiro e parâmetros SQL não são exportados. A exportação
OTLP em batch é independente do commit financeiro. Health e métricas não geram
spans HTTP.

Contagens financeiras e backlog/idade são consultados no banco; contadores
operacionais são por processo. Os totais de transições dependem da retenção dos
eventos da outbox. Comandos e agregação estão no guia de desenvolvimento.

## Autenticação

O guard atual permite as requisições sem token, conforme permitido no desafio.
O ponto de extensão para autenticação fica na camada HTTP.
