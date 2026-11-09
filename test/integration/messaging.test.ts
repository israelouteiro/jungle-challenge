import { FailWager } from '../../src/application/use-cases/fail-wager';
import process from 'node:process';
import { beforeAll, afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { Database } from '../../src/infrastructure/database/database';
import { createServices } from '../support/create-services';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import { Money } from '../../src/domain/money';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
import { WagerConsumer } from '../../src/infrastructure/messaging/wager-consumer';
import { ProcessWager } from '../../src/application/use-cases/process-wager';
import { MikroOrmFinancialUnitOfWork } from '../../src/infrastructure/database/financial-unit-of-work';
import { Sqs } from '../../src/infrastructure/messaging/sqs';
import { Telemetry } from '../../src/observability/telemetry';
const db = new Database();
const sqs = new Sqs();
let service: ReturnType<typeof createServices>;
let publisher: OutboxPublisher;
let consumer: WagerConsumer;
beforeAll(async () => {
  await db.onModuleInit();
  await db.orm.migrator.up();
  service = createServices(db);
  publisher = new OutboxPublisher(db, sqs, new Telemetry());
  consumer = new WagerConsumer(
    new ProcessWager(new MikroOrmFinancialUnitOfWork(db)),
    new FailWager(new MikroOrmFinancialUnitOfWork(db)),
    sqs,
    new Telemetry(),
  );
  await sqs.ready();
});
afterAll(async () => {
  sqs.client.destroy();
  await db.onApplicationShutdown();
});
async function request() {
  const wallet = await service.openWallet(
    randomUUID(),
    Money.from({ amount: '100.00', currency: 'BRL' }),
  );
  const external = randomUUID();
  const envelope = {
    messageId: randomUUID(),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'sqs-test',
      externalTransactionId: external,
      idempotencyKey: `sqs-test:${external}`,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round',
      gameId: 'game',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    },
  };
  return { wallet, envelope };
}
async function send(envelope: unknown, group = randomUUID()) {
  await sqs.client.send(
    new SendMessageCommand({
      QueueUrl: sqs.incoming,
      MessageBody: JSON.stringify(envelope),
      MessageGroupId: group,
      MessageDeduplicationId: randomUUID(),
    }),
  );
}
test('real SQS redelivery with a new transport message ID keeps one debit', async () => {
  const { wallet, envelope } = await request();
  await send(envelope);
  await consumer.consumeOnce();
  await send(envelope);
  await consumer.consumeOnce();
  const result = await service.reconcile(wallet.id);
  expect(result.consistent).toBe(true);
  expect(result.storedBalance.amount).toBe('75.00');
  expect(result.checkedEntries).toBe(2);
  const inbox = await db.orm.em
    .fork()
    .execute(
      'SELECT * FROM inbox WHERE message_id=? AND processed_at IS NOT NULL',
      [envelope.messageId],
    );
  expect(inbox).toHaveLength(1);
});
test('malformed message is moved to real DLQ', async () => {
  const bad = { messageId: randomUUID(), type: 'Invalid' };
  await send(bad);
  await consumer.consumeOnce();
  const result = await sqs.client.send(
    new ReceiveMessageCommand({
      QueueUrl: sqs.dlq,
      WaitTimeSeconds: 1,
      MaxNumberOfMessages: 10,
    }),
  );
  expect(
    result.Messages?.some(
      (message) => JSON.parse(message.Body!).messageId === bad.messageId,
    ),
  ).toBe(true);
  for (const message of result.Messages ?? [])
    await sqs.client.send(
      new DeleteMessageCommand({
        QueueUrl: sqs.dlq,
        ReceiptHandle: message.ReceiptHandle!,
      }),
    );
});
test('kill worker after commit before ack, restart and redeliver without duplicate effects', async () => {
  const { wallet, envelope } = await request();
  await send(envelope);
  const child = Bun.spawn([process.execPath, 'test/fixtures/worker.ts'], {
    env: { ...process.env, NODE_ENV: 'test', FAILPOINT: 'afterCommit' },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const exit = await child.exited;
  expect(exit).not.toBe(0);
  expect((await service.reconcile(wallet.id)).storedBalance.amount).toBe(
    '75.00',
  );
  await new Promise((resolve) => setTimeout(resolve, 2200));
  await consumer.consumeOnce();
  const result = await service.reconcile(wallet.id);
  expect(result.consistent).toBe(true);
  expect(result.storedBalance.amount).toBe('75.00');
  expect(result.checkedEntries).toBe(2);
});
test('two concurrent outbox publishers drain committed events without losing rows', async () => {
  const { wallet } = await request();
  const second = new OutboxPublisher(db, sqs, new Telemetry());
  let remaining = 1;
  for (let iteration = 0; iteration < 100 && remaining; iteration++) {
    await Promise.all([publisher.publishOnce(), second.publishOnce()]);
    const [row] = await db.orm.em
      .fork()
      .execute<{ count: string }[]>(
        `SELECT count(*)::text AS count FROM outbox WHERE published_at IS NULL`,
      );
    remaining = Number(row!.count);
  }
  expect(remaining).toBe(0);
  const rows = await db.orm.em
    .fork()
    .execute(
      `SELECT * FROM outbox WHERE aggregate_id=? AND published_at IS NOT NULL`,
      [wallet.id],
    );
  expect(rows).toHaveLength(2);
  expect((await service.reconcile(wallet.id)).consistent).toBe(true);
});

test('transient PostgreSQL failure retries without committing partial financial state', async () => {
  const { wallet, envelope } = await request();
  const suffix = randomUUID().replaceAll('-', '');
  const em = db.orm.em.fork();
  await em.execute(`CREATE FUNCTION transient_${suffix}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.message_id = '${envelope.messageId}' THEN RAISE EXCEPTION 'simulated write outage'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER transient_${suffix} BEFORE INSERT ON inbox FOR EACH ROW EXECUTE FUNCTION transient_${suffix}();`);
  try {
    await send(envelope);
    await consumer.consumeOnce();
    expect((await service.reconcile(wallet.id)).storedBalance.amount).toBe(
      '100.00',
    );
    expect(
      await em.execute('SELECT * FROM inbox WHERE message_id=?', [
        envelope.messageId,
      ]),
    ).toHaveLength(0);
  } finally {
    await em.execute(
      `DROP TRIGGER transient_${suffix} ON inbox; DROP FUNCTION transient_${suffix}();`,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 2200));
  await consumer.consumeOnce();
  const result = await service.reconcile(wallet.id);
  expect(result.consistent).toBe(true);
  expect(result.storedBalance.amount).toBe('75.00');
});
test('publisher killed after SQS send recovers the same persisted event IDs', async () => {
  const { wallet } = await request();
  const before = await db.orm.em
    .fork()
    .execute<{ id: string }[]>(
      'SELECT id FROM outbox WHERE aggregate_id=? ORDER BY id',
      [wallet.id],
    );
  const child = Bun.spawn(
    [process.execPath, 'test/fixtures/worker.ts', 'publish'],
    {
      env: { ...process.env, NODE_ENV: 'test', FAILPOINT: 'afterPublish' },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  );
  expect(await child.exited).not.toBe(0);
  const pending = await db.orm.em
    .fork()
    .execute(
      'SELECT id FROM outbox WHERE aggregate_id=? AND published_at IS NULL',
      [wallet.id],
    );
  expect(pending).toHaveLength(2);
  await publisher.publishOnce();
  const after = await db.orm.em
    .fork()
    .execute<{ id: string }[]>(
      'SELECT id FROM outbox WHERE aggregate_id=? AND published_at IS NOT NULL ORDER BY id',
      [wallet.id],
    );
  expect(after).toEqual(before);
  expect((await service.reconcile(wallet.id)).consistent).toBe(true);
});
