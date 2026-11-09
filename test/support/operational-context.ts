import process from 'node:process';
import { beforeAll, afterAll, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { Database } from '../../src/infrastructure/database/database';
import { createServices } from './create-services';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind as Kind } from '../../src/domain/wager-transaction';
import { Sqs } from '../../src/infrastructure/messaging/sqs';

export function createOperationalContext() {
  const db = new Database();
  const services = createServices(db);
  beforeAll(async () => {
    await db.onModuleInit();
    await db.orm.migrator.up();
  });
  afterAll(async () => {
    await db.onApplicationShutdown();
  });
  async function request(kind = Kind.Bet) {
    const wallet = await services.openWallet(
      randomUUID(),
      Money.from({ amount: '100.00', currency: 'BRL' }),
    );
    const external = randomUUID();
    const data = {
      providerId: 'operations',
      externalTransactionId: external,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round',
      gameId: 'game',
      kind,
      money: { amount: '25.00', currency: 'BRL' },
    };
    const envelope = {
      messageId: randomUUID(),
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: { ...data, idempotencyKey: external },
    };
    return { wallet, data, envelope };
  }
  async function assertBalance(id: string, amount: string) {
    const result = await services.reconcile(id);
    expect(result.consistent).toBe(true);
    expect(result.storedBalance.amount).toBe(amount);
  }

  return { db, services, request, assertBalance };
}

export async function send(sqs: Sqs, envelope: unknown) {
  await sqs.client.send(
    new SendMessageCommand({
      QueueUrl: sqs.incoming,
      MessageBody: JSON.stringify(envelope),
      MessageGroupId: randomUUID(),
      MessageDeduplicationId: randomUUID(),
    }),
  );
}
export async function until(check: () => Promise<boolean>, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Condition did not become true');
}
export function spawnWorker(
  mode: string,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  return Bun.spawn(
    [process.execPath, 'test/fixtures/worker.ts', mode, ...args],
    { env: { ...process.env, ...env }, stdout: 'ignore', stderr: 'pipe' },
  );
}
