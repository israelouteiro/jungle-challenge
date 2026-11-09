import { DlqAuditor } from '../../src/infrastructure/messaging/dlq-auditor';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  ReceiveMessageCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';
import { isolatedQueues } from '../support/queues';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/wager-transaction';
import { ProcessWager } from '../../src/application/use-cases/process-wager';
import { FailWager } from '../../src/application/use-cases/fail-wager';
import { MikroOrmFinancialUnitOfWork } from '../../src/infrastructure/database/financial-unit-of-work';
import { WagerConsumer } from '../../src/infrastructure/messaging/wager-consumer';
import { MESSAGING_POLICY } from '../../src/infrastructure/messaging/messaging-policy';
import { FinancialMetrics } from '../../src/infrastructure/database/financial-metrics';
import { Telemetry } from '../../src/observability/telemetry';
import { createOperationalContext, send } from '../support/operational-context';

const { db, services, request, assertBalance } = createOperationalContext();

test('five real deliveries exhaust processing retries, persist FAILED, and move to DLQ', async () => {
  const queues = await isolatedQueues();
  const { wallet, data, envelope } = await request();
  const suffix = randomUUID().replaceAll('-', '');
  const em = db.orm.em.fork();
  const telemetry = new Telemetry();
  const uow = new MikroOrmFinancialUnitOfWork(db);
  // Only time is accelerated. Receives, receipt handles, receive counts, writes and DLQ are real.
  const consumer = new WagerConsumer(
    new ProcessWager(uow),
    new FailWager(uow),
    queues.sqs,
    telemetry,
    { ...MESSAGING_POLICY, maxRetrySeconds: 0 },
  );
  const before = await new FinancialMetrics(db).collect();
  await em.execute(`CREATE FUNCTION failing_${suffix}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.wallet_id = '${wallet.id}' AND NEW.direction = 'DEBIT' THEN RAISE EXCEPTION 'injected ledger storage failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER failing_${suffix} BEFORE INSERT ON wallet_ledger FOR EACH ROW EXECUTE FUNCTION failing_${suffix}();`);
  try {
    await send(queues.sqs, envelope);
    for (let attempt = 1; attempt <= 5; attempt++) {
      await consumer.consumeOnce();
      if (attempt < 5)
        await expect(
          services.transactionByExternalId(
            data.providerId,
            data.externalTransactionId,
          ),
        ).rejects.toThrow();
    }
    const failed = await services.transactionByExternalId(
      data.providerId,
      data.externalTransactionId,
    );
    expect(failed.status).toBe(Status.Failed);
    expect(failed.failureCode).toBe('INFRASTRUCTURE_RETRY_EXHAUSTED');
    expect(telemetry.render()).toContain('jungle_retries_total 4\n');
    expect(telemetry.render()).toContain('jungle_dlq_messages_total 1\n');
    const dlq = await queues.sqs.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.sqs.dlq,
        WaitTimeSeconds: 1,
        MaxNumberOfMessages: 10,
        MessageAttributeNames: ['All'],
      }),
    );
    expect(dlq.Messages).toHaveLength(1);
    const message = dlq.Messages![0]!;
    expect(JSON.parse(message.Body!).messageId).toBe(envelope.messageId);
    expect(message.MessageAttributes?.failureCode?.StringValue).toBe(
      'INFRASTRUCTURE_RETRY_EXHAUSTED',
    );
    expect(message.MessageAttributes?.failurePhase?.StringValue).toBe(
      'PROCESSING',
    );
    await queues.sqs.client.send(
      new DeleteMessageCommand({
        QueueUrl: queues.sqs.dlq,
        ReceiptHandle: message.ReceiptHandle!,
      }),
    );
    const replay = await services.submit(data, data.externalTransactionId);
    expect(replay.status).toBe(Status.Failed);
    expect(replay.idempotentReplay).toBe(true);
    const [counts] = await em.execute<
      { failed_events: string; ledger: string }[]
    >(
      `SELECT (SELECT count(*) FROM outbox WHERE aggregate_id=? AND event_type='WagerTransactionFailed')::text AS failed_events,
        (SELECT count(*) FROM wallet_ledger WHERE wallet_id=?)::text AS ledger`,
      [wallet.id, wallet.id],
    );
    expect(counts!.failed_events).toBe('1');
    expect(counts!.ledger).toBe('1');
    const after = await new FinancialMetrics(db).collect();
    expect(after[Status.Failed].current - before[Status.Failed].current).toBe(
      1,
    );
    expect(
      after[Status.Failed].transitions - before[Status.Failed].transitions,
    ).toBe(1);
    await assertBalance(wallet.id, '100.00');
  } finally {
    await em.execute(
      `DROP TRIGGER failing_${suffix} ON wallet_ledger; DROP FUNCTION failing_${suffix}();`,
    );
    await queues.close();
  }
});

test('failure finalization cannot overwrite a processed or accepted pending result', async () => {
  const { wallet, data } = await request();
  const original = await services.submit(data, data.externalTransactionId);
  const failer = new FailWager(new MikroOrmFinancialUnitOfWork(db));
  const finalized = await failer.execute(data, data.externalTransactionId, {
    consumerName: 'finalization-test',
    messageId: randomUUID(),
    hash: 'a'.repeat(64),
  });
  expect(finalized.status).toBe(Status.Processed);
  expect(finalized.balance).toEqual(original.balance);
  const pendingInput = {
    ...data,
    externalTransactionId: randomUUID(),
    kind: Kind.Refund,
    referenceExternalTransactionId: randomUUID(),
  };
  const pending = await services.submit(
    pendingInput,
    pendingInput.externalTransactionId,
  );
  const preserved = await failer.execute(
    pendingInput,
    pendingInput.externalTransactionId,
    {
      consumerName: 'finalization-test',
      messageId: randomUUID(),
      hash: 'b'.repeat(64),
    },
  );
  expect(preserved.transactionId).toBe(pending.transactionId);
  expect(preserved.status).toBe(Status.PendingReference);
  await assertBalance(wallet.id, '75.00');
});

test('redelivery after FAILED commit but before DLQ send still reaches the DLQ', async () => {
  const queues = await isolatedQueues();
  const { wallet, data, envelope } = await request();
  const uow = new MikroOrmFinancialUnitOfWork(db);
  const { payloadHash } = await import('../../src/domain/payload-hash');
  await new FailWager(uow).execute(data, data.externalTransactionId, {
    consumerName: 'wagering-v1',
    messageId: envelope.messageId,
    hash: payloadHash({ ...data, idempotencyKey: data.externalTransactionId }),
  });
  try {
    await send(queues.sqs, envelope);
    const consumer = new WagerConsumer(
      new ProcessWager(uow),
      new FailWager(uow),
      queues.sqs,
      new Telemetry(),
    );
    await consumer.consumeOnce();
    const dlq = await queues.sqs.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.sqs.dlq,
        WaitTimeSeconds: 1,
      }),
    );
    expect(dlq.Messages).toHaveLength(1);
    expect(JSON.parse(dlq.Messages![0]!.Body!).messageId).toBe(
      envelope.messageId,
    );
    await assertBalance(wallet.id, '100.00');
  } finally {
    await queues.close();
  }
});

test('native SQS redrive is audited after recovery without deleting DLQ evidence', async () => {
  const queues = await isolatedQueues();
  const { wallet, data, envelope } = await request();
  try {
    await send(queues.sqs, envelope);
    // Emulate five processes dying before accepting the command: only the broker survives.
    for (let i = 0; i < 5; i++) {
      const received = await queues.sqs.client.send(
        new ReceiveMessageCommand({
          QueueUrl: queues.sqs.incoming,
          WaitTimeSeconds: 1,
        }),
      );
      expect(received.Messages).toHaveLength(1);
      await queues.sqs.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queues.sqs.incoming,
          ReceiptHandle: received.Messages![0]!.ReceiptHandle!,
          VisibilityTimeout: 0,
        }),
      );
    }
    await queues.sqs.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.sqs.incoming,
        WaitTimeSeconds: 1,
      }),
    );
    await expect(
      services.transactionByExternalId(
        data.providerId,
        data.externalTransactionId,
      ),
    ).rejects.toThrow();
    await new DlqAuditor(
      new FailWager(new MikroOrmFinancialUnitOfWork(db)),
      queues.sqs,
      new Telemetry(),
    ).auditOnce();
    const audited = await services.transactionByExternalId(
      data.providerId,
      data.externalTransactionId,
    );
    expect(audited.status).toBe(Status.Failed);
    expect(audited.failureCode).toBe('INFRASTRUCTURE_RETRY_EXHAUSTED');
    const attributes = await queues.sqs.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queues.sqs.dlq,
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
        ],
      }),
    );
    expect(
      Number(attributes.Attributes?.ApproximateNumberOfMessages ?? '0') +
        Number(
          attributes.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0',
        ),
    ).toBe(1);
    await assertBalance(wallet.id, '100.00');
  } finally {
    await queues.close();
  }
});

test('DLQ failure auditing still enforces player and wallet currency identity', async () => {
  const { wallet, data } = await request();
  const failer = new FailWager(new MikroOrmFinancialUnitOfWork(db));
  const mismatches = [
    {
      input: {
        ...data,
        externalTransactionId: randomUUID(),
        playerId: randomUUID(),
      },
      code: 'INVALID_TRANSACTION',
    },
    {
      input: {
        ...data,
        externalTransactionId: randomUUID(),
        money: { amount: '25.00', currency: 'USD' },
      },
      code: 'CURRENCY_MISMATCH',
    },
  ];
  for (const { input, code } of mismatches) {
    const result = await failer.execute(input, input.externalTransactionId, {
      consumerName: 'dlq-identity-test',
      messageId: randomUUID(),
      hash: 'a'.repeat(64),
    });
    expect(result.status).toBe(Status.Rejected);
    expect(result.failureCode).toBe(code);
  }
  await assertBalance(wallet.id, '100.00');
});
