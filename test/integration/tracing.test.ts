import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { isolatedQueues } from '../support/queues';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';

test('real Bun HTTP exports OTLP parent spans and persists outbox trace context', async () => {
  const queues = await isolatedQueues();
  const batches: unknown[] = [];
  const collector = Bun.serve({
    port: 0,
    async fetch(request) {
      batches.push(await request.json());
      return Response.json({});
    },
  });
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  const child = Bun.spawn([process.execPath, 'dist/main.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      WORKERS_ENABLED: 'true',
      SQS_ENDPOINT: queues.configuration.endpoint,
      SQS_QUEUE_URL: queues.configuration.incoming,
      SQS_EVENTS_URL: queues.configuration.events,
      SQS_DLQ_URL: queues.configuration.dlq,
      OTEL_ENABLED: 'true',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://localhost:${collector.port}/v1/traces`,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const url = `http://localhost:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        ready = (await fetch(url + '/health/ready')).ok;
      } catch {}
      if (ready) break;
      await Bun.sleep(50);
    }
    expect(ready).toBe(true);
    const traceId = '1234567890abcdef1234567890abcdef';
    const response = await fetch(url + '/wallets', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        traceparent: `00-${traceId}-1234567890abcdef-01`,
      },
      body: JSON.stringify({
        playerId: randomUUID(),
        initialBalance: { amount: '10.00', currency: 'BRL' },
      }),
    });
    expect(response.status).toBe(201);
    const wallet = (await response.json()) as { id: string };
    const { Database } =
      await import('../../src/infrastructure/database/database');
    const db = new Database();
    await db.onModuleInit();
    try {
      const rows = await db.orm.em
        .fork()
        .execute<{ payload: { traceContext: { traceparent: string } } }[]>(
          'SELECT payload FROM outbox WHERE aggregate_id=?',
          [wallet.id],
        );
      expect(rows.length).toBeGreaterThan(0);
      expect(
        rows.every((row) =>
          row.payload.traceContext.traceparent.includes(traceId),
        ),
      ).toBe(true);
    } finally {
      await db.onApplicationShutdown();
    }
    for (
      let i = 0;
      i < 100 && !JSON.stringify(batches).includes('outbox.publish');
      i++
    )
      await Bun.sleep(100);
    await queues.sqs.client.send(
      new SendMessageCommand({
        QueueUrl: queues.configuration.incoming,
        MessageBody: JSON.stringify({
          messageId: randomUUID(),
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            providerId: 'tracing',
            externalTransactionId: randomUUID(),
            idempotencyKey: randomUUID(),
            playerId: (
              (await (await fetch(url + `/wallets/${wallet.id}`)).json()) as {
                playerId: string;
              }
            ).playerId,
            walletId: wallet.id,
            kind: 'WIN',
            money: { amount: '1.00', currency: 'BRL' },
            gameId: 'trace',
            roundId: 'trace',
          },
        }),
        MessageGroupId: wallet.id,
        MessageDeduplicationId: randomUUID(),
        MessageAttributes: {
          traceparent: {
            DataType: 'String',
            StringValue: `00-${traceId}-1234567890abcdef-01`,
          },
        },
      }),
    );
    for (
      let i = 0;
      i < 100 && !JSON.stringify(batches).includes('wager.process');
      i++
    )
      await Bun.sleep(100);
    child.kill('SIGTERM');
    await child.exited;
    const payload = JSON.stringify(batches);
    expect(payload).toContain('POST /wallets');
    expect(payload).toContain('financial.transaction');
    expect(payload).toContain('outbox.publish');
    expect(payload).toContain('wager.process');
    expect(payload).toContain(traceId);
    expect(payload).not.toContain('INSERT INTO');
    const spans = (
      batches as {
        resourceSpans: {
          scopeSpans: {
            spans: {
              name: string;
              traceId: string;
              spanId: string;
              parentSpanId?: string;
            }[];
          }[];
        }[];
      }[]
    ).flatMap((batch) =>
      batch.resourceSpans.flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) => scope.spans),
      ),
    );
    const requestSpan = spans.find((span) => span.name === 'POST /wallets')!;
    expect(requestSpan.traceId).toBe(traceId);
    expect(
      spans.some(
        (span) =>
          span.name === 'financial.transaction' &&
          span.parentSpanId === requestSpan.spanId,
      ),
    ).toBe(true);
    expect(
      spans.some(
        (span) => span.name === 'outbox.publish' && span.traceId === traceId,
      ),
    ).toBe(true);
    expect(
      spans.some(
        (span) => span.name === 'wager.process' && span.traceId === traceId,
      ),
    ).toBe(true);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await child.exited;
    collector.stop(true);
    await queues.close();
  }
});
