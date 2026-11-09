import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { WalletController } from '../../src/http/wallet.controller';
import { WageringController } from '../../src/http/wagering.controller';
import { HealthController } from '../../src/http/health.controller';
import { Database } from '../../src/infrastructure/database/database';
import { FailWager } from '../../src/application/use-cases/fail-wager';
import { MikroOrmFinancialUnitOfWork } from '../../src/infrastructure/database/financial-unit-of-work';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import process from 'node:process';
import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
const children: ReturnType<typeof Bun.spawn>[] = [];
const urls: string[] = [];
afterAll(async () => {
  for (const child of children) child.kill('SIGTERM');
  await Promise.all(children.map((child) => child.exited));
});
async function start(port: number) {
  const child = Bun.spawn([process.execPath, 'dist/main.js'], {
    env: { ...process.env, WORKERS_ENABLED: 'false', PORT: String(port) },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  children.push(child);
  const url = `http://localhost:${port}`;
  for (let tries = 0; tries < 100; tries++) {
    try {
      if ((await fetch(`${url}/health/ready`)).ok) return url;
    } catch {}
    if (child.exitCode !== null)
      throw new Error(`Application process exited: ${child.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Application did not become ready');
}
async function json(url: string, path: string, body?: unknown, key?: string) {
  return fetch(url + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}
test('three independent NestJS processes share persistent idempotency and wallet locking', async () => {
  const basePort = 42000 + Math.floor(Math.random() * 1000);
  urls.push(
    ...(await Promise.all([
      start(basePort),
      start(basePort + 1),
      start(basePort + 2),
    ])),
  );

  for (const amount of ['25', '25.0', '25.000', 25]) {
    const invalid = await json(urls[0]!, '/wallets', {
      playerId: randomUUID(),
      initialBalance: { amount, currency: 'BRL' },
    });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { code: string }).code).toBe(
      'INVALID_MONEY',
    );
  }
  const docsResponse = await fetch(urls[0]! + '/docs/');
  expect(docsResponse.status).toBe(200);
  expect(await docsResponse.text()).toContain('assets/main.bundle.js');
  const documentedRoutes = (await (
    await fetch(urls[0]! + '/docs/assets/api-data.json')
  ).json()) as { type: string; url: string }[];
  const runtimeRoutes = [
    WalletController,
    WageringController,
    HealthController,
  ].flatMap((controller) =>
    Object.getOwnPropertyNames(controller.prototype).flatMap((name) => {
      const handler = Object.getOwnPropertyDescriptor(
        controller.prototype,
        name,
      )?.value as unknown;
      if (typeof handler !== 'function') return [];
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as
        RequestMethod | undefined;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as
        string | undefined;
      if (method === undefined || path === undefined) return [];
      return [`${RequestMethod[method]} /${path.replace(/^\//, '')}`];
    }),
  );
  expect(
    documentedRoutes
      .map((route) => `${route.type.toUpperCase()} ${route.url}`)
      .sort(),
  ).toEqual(runtimeRoutes.sort());
  expect(
    documentedRoutes.map((route) => `${route.type.toUpperCase()} ${route.url}`),
  ).toContain('POST /wagering/transactions');
  expect((await fetch(urls[0]! + '/docs/assets/main.bundle.js')).status).toBe(
    200,
  );
  const metrics = await (await fetch(urls[0]! + '/metrics')).text();
  expect(metrics).toContain('jungle_wager_transactions{status="PROCESSED"}');
  expect(metrics).toContain(
    'jungle_transaction_transitions_total{status="PROCESSED"}',
  );
  const wallet = (await (
    await json(urls[0]!, '/wallets', {
      playerId: randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    })
  ).json()) as { id: string; playerId: string };
  expect(wallet.id).toBeDefined();
  const tx = {
    providerId: 'process-test',
    externalTransactionId: randomUUID(),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round',
    gameId: 'game',
    kind: 'BET',
    money: { amount: '80.00', currency: 'BRL' },
  };
  const key = randomUUID();
  const responses = await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      json(urls[index % 3]!, '/wagering/transactions', tx, key),
    ),
  );
  expect(responses.every((response) => response.status === 200)).toBe(true);
  const results = (await Promise.all(
    responses.map((response) => response.json()),
  )) as { transactionId: string; idempotentReplay: boolean }[];
  expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
  expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
  const uppercaseReplay = await json(
    urls[1]!,
    '/wagering/transactions',
    {
      ...tx,
      playerId: tx.playerId.toUpperCase(),
      walletId: tx.walletId.toUpperCase(),
    },
    key,
  );
  expect(uppercaseReplay.status).toBe(200);
  expect(
    ((await uppercaseReplay.json()) as { transactionId: string }).transactionId,
  ).toBe(results[0]!.transactionId);
  const firstPage = (await (
    await json(urls[0]!, `/wallets/${wallet.id.toUpperCase()}/ledger?limit=1`)
  ).json()) as { items: { id: string }[]; nextCursor: string };
  const secondPage = (await (
    await json(
      urls[0]!,
      `/wallets/${wallet.id}/ledger?limit=1&cursor=${firstPage.nextCursor}`,
    )
  ).json()) as { items: { id: string }[]; nextCursor: null };
  expect(firstPage.items).toHaveLength(1);
  expect(secondPage.items).toHaveLength(1);
  expect(firstPage.items[0]!.id).not.toBe(secondPage.items[0]!.id);
  expect(secondPage.nextCursor).toBeNull();
  for (const sequence of [123, null, '9223372036854775808', '1.5']) {
    const cursor = Buffer.from(
      JSON.stringify({ walletId: wallet.id, sequence }),
    ).toString('base64url');
    expect(
      (await json(urls[0]!, `/wallets/${wallet.id}/ledger?cursor=${cursor}`))
        .status,
    ).toBe(400);
  }
  const conflict = await json(
    urls[1]!,
    '/wagering/transactions',
    { ...tx, roundId: 'other' },
    key,
  );
  expect(conflict.status).toBe(409);
  const rejected = await json(
    urls[2]!,
    '/wagering/transactions',
    { ...tx, externalTransactionId: randomUUID() },
    randomUUID(),
  );
  expect(rejected.status).toBe(422);
  const reconciliation = (await (
    await json(urls[0]!, `/wallets/${wallet.id}/reconciliation`, {})
  ).json()) as { consistent: boolean; storedBalance: { amount: string } };
  expect(reconciliation.consistent).toBe(true);
  expect(reconciliation.storedBalance.amount).toBe('20.00');

  const raceWallet = (await (
    await json(urls[0]!, '/wallets', {
      playerId: randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    })
  ).json()) as { id: string; playerId: string };
  const competing = await Promise.all(
    urls.map((url) =>
      json(
        url,
        '/wagering/transactions',
        {
          ...tx,
          externalTransactionId: randomUUID(),
          walletId: raceWallet.id,
          playerId: raceWallet.playerId,
        },
        randomUUID(),
      ),
    ),
  );
  expect(competing.map((response) => response.status).sort()).toEqual([
    200, 422, 422,
  ]);
  const raceReconciliation = (await (
    await json(urls[0]!, `/wallets/${raceWallet.id}/reconciliation`, {})
  ).json()) as {
    consistent: boolean;
    storedBalance: { amount: string };
    checkedEntries: number;
  };
  expect(raceReconciliation.consistent).toBe(true);
  expect(raceReconciliation.storedBalance.amount).toBe('20.00');
  expect(raceReconciliation.checkedEntries).toBe(2);
  const database = new Database();
  await database.onModuleInit();
  try {
    const failedInput = {
      ...tx,
      externalTransactionId: randomUUID(),
      kind: WagerTransactionKind.Win,
    };
    const failedKey = randomUUID();
    await new FailWager(new MikroOrmFinancialUnitOfWork(database)).execute(
      failedInput,
      failedKey,
      {
        consumerName: 'http-failed-test',
        messageId: randomUUID(),
        hash: 'a'.repeat(64),
      },
    );
    const failedResponse = await json(
      urls[1]!,
      '/wagering/transactions',
      failedInput,
      failedKey,
    );
    expect(failedResponse.status).toBe(500);
    const failedBody = (await failedResponse.json()) as {
      status: string;
      failureCode: string;
      idempotentReplay: boolean;
    };
    expect(failedBody.status).toBe('FAILED');
    expect(failedBody.failureCode).toBe('INFRASTRUCTURE_RETRY_EXHAUSTED');
    expect(failedBody.idempotentReplay).toBe(true);
  } finally {
    await database.onApplicationShutdown();
  }
  // Restart an application process; the original result remains available from PostgreSQL.
  children[0]!.kill('SIGTERM');
  await children[0]!.exited;
  const restarted = await start(basePort);
  const replay = (await (
    await json(restarted, '/wagering/transactions', tx, key)
  ).json()) as { idempotentReplay: boolean; balance: { amount: string } };
  expect(replay.idempotentReplay).toBe(true);
  expect(replay.balance.amount).toBe('20.00');
  const afterRestart = (await (
    await json(restarted, `/wallets/${wallet.id}/reconciliation`, {})
  ).json()) as { consistent: boolean; storedBalance: { amount: string } };
  expect(afterRestart.consistent).toBe(true);
  expect(afterRestart.storedBalance.amount).toBe('20.00');
});
