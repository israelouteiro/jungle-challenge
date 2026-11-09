import process from 'node:process';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { isolatedQueues } from '../support/queues';
import {
  createOperationalContext,
  send,
  until,
  spawnWorker,
} from '../support/operational-context';

const { db, request, assertBalance } = createOperationalContext();

test('three consumer processes race on one operation without duplicate financial effects', async () => {
  const queues = await isolatedQueues();
  const { wallet, envelope } = await request();
  const children: ReturnType<typeof spawnWorker>[] = [];
  try {
    const messageIds = Array.from({ length: 3 }, () => randomUUID());
    for (const messageId of messageIds)
      await send(queues.sqs, { ...envelope, messageId });
    for (let i = 0; i < 3; i++)
      children.push(
        spawnWorker('consume', [], {
          SQS_ENDPOINT: queues.configuration.endpoint,
          SQS_QUEUE_URL: queues.sqs.incoming,
          SQS_EVENTS_URL: queues.sqs.events,
          SQS_DLQ_URL: queues.sqs.dlq,
        }),
      );
    expect(await Promise.all(children.map((child) => child.exited))).toEqual([
      0, 0, 0,
    ]);
    const [row] = await db.orm.em
      .fork()
      .execute<{ count: string }[]>(
        'SELECT count(*)::text AS count FROM wallet_ledger WHERE wallet_id=?',
        [wallet.id],
      );
    expect(row!.count).toBe('2');
    const inbox = await db.orm.em
      .fork()
      .execute(
        'SELECT * FROM inbox WHERE consumer_name=? AND message_id IN (?,?,?) AND processed_at IS NOT NULL',
        ['wagering-v1', ...messageIds],
      );
    expect(inbox).toHaveLength(3);
    await assertBalance(wallet.id, '75.00');
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exited));
    await queues.close();
  }
});

test('SIGTERM during a blocked financial operation waits for commit and acknowledges before exiting', async () => {
  const queues = await isolatedQueues();
  const { wallet, envelope } = await request();
  let release!: () => void;
  let acquired!: () => void;
  const held = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lock = db.orm.em.fork().transactional(async (em) => {
    await em.execute('SELECT id FROM wallets WHERE id=? FOR UPDATE', [
      wallet.id,
    ]);
    acquired();
    await gate;
  });
  await held;
  await send(queues.sqs, envelope);
  const instance = `shutdown-${randomUUID()}`;
  const child = Bun.spawn([process.execPath, 'dist/main.js'], {
    env: {
      ...process.env,
      INSTANCE_ID: instance,
      PORT: '0',
      WORKERS_ENABLED: 'true',
      SQS_ENDPOINT: queues.configuration.endpoint,
      SQS_QUEUE_URL: queues.sqs.incoming,
      SQS_EVENTS_URL: queues.sqs.events,
      SQS_DLQ_URL: queues.sqs.dlq,
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  try {
    await until(
      async () =>
        (
          await db.orm.em
            .fork()
            .execute(
              "SELECT pid FROM pg_stat_activity WHERE application_name=? AND wait_event_type='Lock'",
              [instance],
            )
        ).length > 0,
    );
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(child.exitCode).toBeNull();
    release();
    await lock;
    // Nest re-emits SIGTERM after awaiting shutdown hooks: 128 + SIGTERM(15).
    expect(await child.exited).toBe(143);
    const inbox = await db.orm.em
      .fork()
      .execute(
        'SELECT message_id FROM inbox WHERE message_id=? AND processed_at IS NOT NULL',
        [envelope.messageId],
      );
    expect(inbox).toHaveLength(1);
    const attributes = await queues.sqs.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queues.sqs.incoming,
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
        ],
      }),
    );
    expect(attributes.Attributes?.ApproximateNumberOfMessages).toBe('0');
    expect(attributes.Attributes?.ApproximateNumberOfMessagesNotVisible).toBe(
      '0',
    );
    await assertBalance(wallet.id, '75.00');
  } finally {
    release();
    await lock;
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
    await queues.close();
  }
});
