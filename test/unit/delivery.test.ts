import { expect, test } from 'bun:test';
import { InboxMessage, OutboxMessage } from '../../src/domain/delivery';
import { WagerTransactionProcessed } from '../../src/domain/integration-event';
const at = new Date('2026-01-01T00:00:00Z');
test('inbox records processing exactly once and protects timestamps', () => {
  const inbox = InboxMessage.receive({
    messageId: 'm',
    consumerName: 'consumer',
    payloadHash: 'a'.repeat(64),
    receivedAt: at,
  });
  expect(inbox.isProcessed()).toBe(false);
  inbox.markProcessed(at);
  expect(inbox.isProcessed()).toBe(true);
  inbox.processedAt!.setFullYear(2000);
  expect(inbox.processedAt!.getUTCFullYear()).toBe(2026);
  expect(() => inbox.markProcessed(at)).toThrow('INVALID_TRANSACTION_STATE');
});
test('outbox retries with capped exponential backoff and immutable JSON payload', () => {
  const event = WagerTransactionProcessed.create(
    { eventId: 'e', aggregateId: 'w', correlationId: 't', occurredAt: at },
    { transactionId: 't', walletId: 'w', providerId: 'p', status: 'PROCESSED' },
  );
  const outbox = OutboxMessage.enqueue(event);
  expect(outbox.isDue(at)).toBe(true);
  outbox.scheduleRetry(at);
  expect(outbox.attempts).toBe(1);
  expect(outbox.nextAttemptAt!.getTime() - at.getTime()).toBe(2000);
  expect(outbox.isDue(at)).toBe(false);
  const payload = outbox.payload;
  (payload.data as Record<string, unknown>).walletId = 'changed';
  expect((outbox.payload.data as Record<string, unknown>).walletId).toBe('w');
  for (let i = 0; i < 20; i++) outbox.scheduleRetry(at);
  expect(outbox.nextAttemptAt!.getTime() - at.getTime()).toBe(3600000);
  outbox.markPublished(at);
  expect(outbox.isPending()).toBe(false);
  expect(() => outbox.scheduleRetry(at)).toThrow();
});
