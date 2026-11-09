import { expect, test } from 'bun:test';
import {
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { isolatedQueues } from '../support/queues';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
import { Sqs } from '../../src/infrastructure/messaging/sqs';
import { Telemetry } from '../../src/observability/telemetry';
import {
  createOperationalContext,
  until,
} from '../support/operational-context';

const { db, request, assertBalance } = createOperationalContext();

test('SQS transport outage retains outbox rows and recovery publishes the original IDs to real SQS', async () => {
  const queues = await isolatedQueues();
  const defaultSqs = new Sqs();
  const drain = new OutboxPublisher(db, defaultSqs, new Telemetry());
  let available = false;
  const proxy = Bun.serve({
    port: 0,
    async fetch(request) {
      if (!available)
        return Response.json(
          { __type: 'ServiceUnavailable', message: 'Injected SQS outage' },
          {
            status: 503,
            headers: { 'x-amzn-ErrorType': 'ServiceUnavailable' },
          },
        );
      const target = new URL(request.url);
      const upstream = new URL(queues.configuration.endpoint);
      target.host = upstream.host;
      target.protocol = upstream.protocol;
      const headers = new Headers(request.headers);
      headers.delete('host');
      return fetch(target, {
        method: request.method,
        headers,
        body:
          request.method === 'GET' ? undefined : await request.arrayBuffer(),
      });
    },
  });
  const rewrite = (url: string) => {
    const target = new URL(url);
    target.host = proxy.url.host;
    target.protocol = proxy.url.protocol;
    return target.toString();
  };
  const gateway = new Sqs({
    endpoint: proxy.url.toString(),
    incoming: rewrite(queues.sqs.incoming),
    events: rewrite(queues.sqs.events),
    dlq: rewrite(queues.sqs.dlq),
  });
  try {
    for (let i = 0; i < 100; i++) if (!(await drain.publishOnce())) break;
    const { wallet } = await request();
    const original = await db.orm.em
      .fork()
      .execute<{ id: string }[]>(
        'SELECT id FROM outbox WHERE aggregate_id=? ORDER BY id',
        [wallet.id],
      );
    const publisher = new OutboxPublisher(db, gateway, new Telemetry());
    expect(await publisher.publishOnce()).toBe(0);
    const rows = await db.orm.em
      .fork()
      .execute<
        { attempts: number; published_at: Date | null; future: boolean }[]
      >(
        'SELECT attempts,published_at,next_attempt_at>now() AS future FROM outbox WHERE aggregate_id=?',
        [wallet.id],
      );
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (row) => row.attempts === 1 && row.published_at === null && row.future,
      ),
    ).toBe(true);
    available = true;
    await db.orm.em
      .fork()
      .execute(
        "UPDATE outbox SET next_attempt_at=now()-interval '1 second' WHERE aggregate_id=?",
        [wallet.id],
      );
    expect(await publisher.publishOnce()).toBe(2);
    const confirmed = await db.orm.em
      .fork()
      .execute<{ id: string }[]>(
        'SELECT id FROM outbox WHERE aggregate_id=? AND published_at IS NOT NULL ORDER BY id',
        [wallet.id],
      );
    expect(confirmed).toEqual(original);
    const received = new Set<string>();
    await until(async () => {
      const response = await queues.sqs.client.send(
        new ReceiveMessageCommand({
          QueueUrl: queues.sqs.events,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
        }),
      );
      for (const message of response.Messages ?? []) {
        const event = JSON.parse(message.Body!);
        expect(event.aggregateId).toBe(wallet.id);
        received.add(event.eventId);
        await queues.sqs.client.send(
          new DeleteMessageCommand({
            QueueUrl: queues.sqs.events,
            ReceiptHandle: message.ReceiptHandle!,
          }),
        );
      }
      return received.size === 2;
    });
    expect([...received].sort()).toEqual(original.map((row) => row.id));
    await assertBalance(wallet.id, '100.00');
  } finally {
    gateway.client.destroy();
    defaultSqs.client.destroy();
    await proxy.stop(true);
    await queues.close();
  }
});
