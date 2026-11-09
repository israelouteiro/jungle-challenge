import { mkdir } from 'node:fs/promises';
const urls = (process.env.LOAD_URLS ?? 'http://app:3000').split(',');
const run = `demo-${crypto.randomUUID()}`;
const report = `artifacts/demo/${run}`;
await mkdir(report, { recursive: true });
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
interface Result {
  transactionId: string;
  status: string;
  balance: { amount: string };
  failureCode?: string;
  idempotentReplay: boolean;
}
let cursor = 0;
async function request<T>(
  name: string,
  path: string,
  body?: unknown,
  key?: string,
): Promise<{ code: number; body: T }> {
  const response = await fetch(`${urls[cursor++ % urls.length]}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key && { 'Idempotency-Key': key }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const value = { code: response.status, body: (await response.json()) as T };
  await Bun.write(
    `${report}/${name}.json`,
    JSON.stringify(value.body, null, 2),
  );
  await Bun.write(`${report}/${name}.status`, String(value.code));
  return value;
}
try {
  console.log('Aguardando coleta das três réplicas...');
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const metrics = (await fetch(
      'http://prometheus:9090/api/v1/query?query=sum(up%7Bjob%3D%22wagering%22%7D)',
      { signal: AbortSignal.timeout(3000) },
    ).then((r) => r.json())) as {
      data: { result: { value: [number, string] }[] };
    };
    if (metrics.data.result[0]?.value[1] === '3') {
      ready = true;
      break;
    }
    await Bun.sleep(1000);
  }
  assert(ready, 'Prometheus não coletou as três réplicas');
  await Bun.sleep(2000);
  const player = crypto.randomUUID();
  const wallet = await request<{ id: string }>('wallet', '/wallets', {
    playerId: player,
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  assert(wallet.code === 201 && wallet.body.id, 'Criação da carteira');
  console.log(`Carteira ${wallet.body.id}: abertura 100.00 BRL`);
  const payload = (
    external: string,
    kind: string,
    amount: string,
    reference?: string,
  ) => ({
    providerId: 'demo-provider',
    externalTransactionId: external,
    walletId: wallet.body.id,
    playerId: player,
    roundId: run,
    gameId: 'demo-game',
    kind,
    money: { amount, currency: 'BRL' },
    ...(reference && { referenceExternalTransactionId: reference }),
  });
  const submit = (name: string, body: ReturnType<typeof payload>) =>
    request<Result>(
      name,
      '/wagering/transactions',
      body,
      body.externalTransactionId,
    );
  console.log('[1/3] Duas apostas de 80.00 em paralelo');
  const bets = [
    payload(`${run}-a`, 'BET', '80.00'),
    payload(`${run}-b`, 'BET', '80.00'),
  ];
  const results = await Promise.all(
    bets.map((body, index) => submit(`bet-${index}`, body)),
  );
  assert(
    results.filter(
      (r) =>
        r.code === 200 &&
        r.body.status === 'PROCESSED' &&
        r.body.balance.amount === '20.00',
    ).length === 1 &&
      results.filter(
        (r) => r.code === 422 && r.body.failureCode === 'INSUFFICIENT_FUNDS',
      ).length === 1,
    'Disputa não produziu um débito e uma rejeição',
  );
  const winner = bets[results.findIndex((r) => r.code === 200)]!;
  const replay = await submit('replay', winner);
  assert(
    replay.code === 200 &&
      replay.body.idempotentReplay &&
      replay.body.balance.amount === '20.00',
    'Replay inválido',
  );
  console.log('[OK] Uma aposta aplicada, outra rejeitada; saldo 20.00 BRL.');
  await Bun.sleep(1000);
  console.log('[2/3] Cinquenta envios simultâneos da mesma aposta de 1.00');
  const duplicate = payload(`${run}-duplicate`, 'BET', '1.00');
  const duplicates = await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      submit(`duplicate-${index}`, duplicate),
    ),
  );
  assert(
    duplicates.every(
      (r) =>
        r.code === 200 &&
        r.body.status === 'PROCESSED' &&
        r.body.balance.amount === '19.00',
    ) &&
      new Set(duplicates.map((r) => r.body.transactionId)).size === 1 &&
      duplicates.filter((r) => !r.body.idempotentReplay).length === 1,
    'Duplicatas alteraram o resultado',
  );
  const historical = await submit('historical-replay', winner);
  assert(
    historical.code === 200 &&
      historical.body.idempotentReplay &&
      historical.body.balance.amount === '20.00',
    'Replay não preservou o saldo histórico',
  );
  console.log(
    '[OK] Um débito, 49 replays; saldo atual 19.00. Replay anterior mantém 20.00.',
  );
  await Bun.sleep(1000);
  console.log('[3/3] REFUND de 5.00 antes da BET referenciada');
  const refund = payload(`${run}-refund`, 'REFUND', '5.00', `${run}-reference`);
  const pending = await submit('pending', refund);
  assert(
    pending.code === 202 && pending.body.status === 'PENDING_REFERENCE',
    'Referência não ficou pendente',
  );
  console.log('PENDING_REFERENCE: aguardando a BET...');
  await Bun.sleep(1500);
  const reference = await submit(
    'reference',
    payload(`${run}-reference`, 'BET', '5.00'),
  );
  assert(reference.code === 200, 'BET referenciada não aplicada');
  let resolved = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await request<Result>(
      'resolved',
      `/wagering/transactions/${pending.body.transactionId}`,
    );
    assert(result.code === 200, 'Consulta da referência');
    if (result.body.status === 'PROCESSED') {
      resolved = true;
      break;
    }
    await Bun.sleep(1000);
  }
  assert(resolved, 'Worker não resolveu a referência no prazo');
  const reconciliation = await request<{
    consistent: boolean;
    storedBalance: { amount: string };
    calculatedBalance: { amount: string };
    checkedEntries: number;
  }>('reconciliation', `/wallets/${wallet.body.id}/reconciliation`, {});
  assert(
    reconciliation.code === 200 &&
      reconciliation.body.consistent &&
      reconciliation.body.storedBalance.amount === '19.00' &&
      reconciliation.body.calculatedBalance.amount === '19.00' &&
      reconciliation.body.checkedEntries === 5,
    'Reconciliação divergente',
  );
  const ledger = await request<{ items: { direction: string }[] }>(
    'ledger',
    `/wallets/${wallet.body.id}/ledger`,
  );
  assert(
    ledger.code === 200 &&
      ledger.body.items.length === 5 &&
      ledger.body.items.filter((e) => e.direction === 'DEBIT').length === 3,
    'Ledger divergente',
  );
  console.log(
    '[OK] Worker resolveu a referência; saldo e ledger reconciliados: 19.00 BRL.',
  );
  console.log(`Respostas: ${report}/`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`Respostas: ${report}/`);
  process.exitCode = 1;
}
