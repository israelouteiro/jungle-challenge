import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { WagerTransactionKind as Kind } from '../../src/domain/wager-transaction';
import { ProcessWager } from '../../src/application/use-cases/process-wager';
import { MikroOrmFinancialUnitOfWork } from '../../src/infrastructure/database/financial-unit-of-work';
import { SqlPendingReferenceReader } from '../../src/infrastructure/database/pending-reference-reader';
import { PendingReferenceWorker } from '../../src/infrastructure/messaging/pending-reference-worker';
import { Telemetry } from '../../src/observability/telemetry';
import {
  createOperationalContext,
  until,
  spawnWorker,
} from '../support/operational-context';

const { db, services, request, assertBalance } = createOperationalContext();

test('three workers selecting the same reference report only the committed retry', async () => {
  const { wallet, data } = await request();
  const pending = await services.submit(
    {
      ...data,
      kind: Kind.Refund,
      referenceExternalTransactionId: randomUUID(),
    },
    data.externalTransactionId,
  );
  await db.orm.em
    .fork()
    .execute(
      "UPDATE wager_transactions SET next_attempt_at=now()-interval '1 second' WHERE id=?",
      [pending.transactionId],
    );
  const reader = new SqlPendingReferenceReader(db);
  const processor = new ProcessWager(new MikroOrmFinancialUnitOfWork(db));
  let selected = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const metrics = Array.from({ length: 3 }, () => new Telemetry());
  // Synchronize real SQL snapshots so every worker sees the same due row.
  await Promise.all(
    metrics.map((telemetry) =>
      new PendingReferenceWorker(
        {
          async dueIds(limit: number) {
            const ids = (await reader.dueIds(limit)).filter(
              (id) => id === pending.transactionId,
            );
            if (++selected === 3) release();
            await gate;
            expect(ids).toEqual([pending.transactionId]);
            return ids;
          },
        },
        processor,
        telemetry,
      ).referencesOnce(),
    ),
  );
  expect(
    metrics.reduce(
      (sum, metric) =>
        sum +
        Number(
          metric.render().match(/jungle_reference_retries_total (\d+)/)![1],
        ),
      0,
    ),
  ).toBe(1);
  const [row] = await db.orm.em
    .fork()
    .execute<{ attempts: number }[]>(
      'SELECT attempts FROM wager_transactions WHERE id=?',
      [pending.transactionId],
    );
  expect(row!.attempts).toBe(2);
  expect(await services.retryPending(pending.transactionId)).toBe(false);
  expect(await services.retryPending(randomUUID())).toBe(false);
  await assertBalance(wallet.id, '100.00');
});

test('three processes waiting on the same due reference consume only ONE retry', async () => {
  const { wallet, data } = await request();
  const pending = await services.submit(
    {
      ...data,
      kind: Kind.Refund,
      referenceExternalTransactionId: randomUUID(),
    },
    data.externalTransactionId,
  );
  await db.orm.em
    .fork()
    .execute(
      "UPDATE wager_transactions SET next_attempt_at=now()-interval '1 second' WHERE id=?",
      [pending.transactionId],
    );
  let release!: () => void;
  let acquired!: () => void;
  const held = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lock = db.orm.em.fork().transactional(async (em) => {
    await em.execute(
      'SELECT id FROM wager_transactions WHERE id=? FOR UPDATE',
      [pending.transactionId],
    );
    acquired();
    await gate;
  });
  await held;
  const instance = `reference-${randomUUID()}`;
  const children = Array.from({ length: 3 }, () =>
    spawnWorker('reference', [pending.transactionId], {
      INSTANCE_ID: instance,
    }),
  );
  try {
    await until(async () => {
      const [row] = await db.orm.em
        .fork()
        .execute<{ count: string }[]>(
          "SELECT count(*)::text AS count FROM pg_stat_activity WHERE application_name=? AND wait_event_type='Lock'",
          [instance],
        );
      return Number(row!.count) === 3;
    });
    release();
    await lock;
    expect(await Promise.all(children.map((child) => child.exited))).toEqual([
      0, 0, 0,
    ]);
    const [row] = await db.orm.em
      .fork()
      .execute<{ attempts: number; future: boolean }[]>(
        'SELECT attempts,next_attempt_at>now() AS future FROM wager_transactions WHERE id=?',
        [pending.transactionId],
      );
    expect(row!.attempts).toBe(2);
    expect(row!.future).toBe(true);
    await services.retryPending(pending.transactionId);
    const [again] = await db.orm.em
      .fork()
      .execute<{ attempts: number }[]>(
        'SELECT attempts FROM wager_transactions WHERE id=?',
        [pending.transactionId],
      );
    expect(again!.attempts).toBe(2);
    await assertBalance(wallet.id, '100.00');
  } finally {
    release();
    await lock;
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exited));
  }
});
