import { expect, test } from 'bun:test';
import { Workers } from '../../src/infrastructure/messaging/workers';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
import { WagerConsumer } from '../../src/infrastructure/messaging/wager-consumer';
import { PendingReferenceWorker } from '../../src/infrastructure/messaging/pending-reference-worker';
import { DlqAuditor } from '../../src/infrastructure/messaging/dlq-auditor';
import { Sqs } from '../../src/infrastructure/messaging/sqs';
import { Telemetry } from '../../src/observability/telemetry';
import { MESSAGING_POLICY } from '../../src/infrastructure/messaging/messaging-policy';

function scheduler(publishOnce: () => Promise<number>) {
  const telemetry = new Telemetry();
  const workers = new Workers(
    { publishOnce } as OutboxPublisher,
    { consumeOnce: async () => {}, stop() {} } as WagerConsumer,
    { referencesOnce: async () => {}, stop() {} } as PendingReferenceWorker,
    { auditOnce: async () => {}, stop() {} } as DlqAuditor,
    { client: { destroy() {} } } as Sqs,
    telemetry,
  );
  return { workers, telemetry };
}

test('publisher drains full batches immediately, then backs off on an empty batch', async () => {
  let calls = 0;
  const { workers } = scheduler(async () =>
    ++calls <= 3 ? MESSAGING_POLICY.outboxBatchSize : 0,
  );
  workers.onApplicationBootstrap();
  try {
    // This timer runs before the 200 ms idle timer even if the event loop is delayed.
    await Bun.sleep(50);
    expect(calls).toBe(4);
  } finally {
    await workers.onModuleDestroy();
  }
  const stoppedAt = calls;
  await Bun.sleep(10);
  expect(calls).toBe(stoppedAt);
});

test('publisher errors preserve the idle backoff instead of spinning', async () => {
  let calls = 0;
  const { workers, telemetry } = scheduler(async () => {
    calls++;
    throw new Error('transport unavailable');
  });
  workers.onApplicationBootstrap();
  try {
    await Bun.sleep(50);
    expect(calls).toBe(1);
    expect(telemetry.render()).toContain('jungle_worker_errors_total 1\n');
  } finally {
    await workers.onModuleDestroy();
  }
});

test('a batch with failed sends keeps the idle backoff', async () => {
  let calls = 0;
  const { workers } = scheduler(async () => {
    calls++;
    return MESSAGING_POLICY.outboxBatchSize - 1;
  });
  workers.onApplicationBootstrap();
  try {
    await Bun.sleep(50);
    expect(calls).toBe(1);
  } finally {
    await workers.onModuleDestroy();
  }
});
