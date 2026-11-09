import process from 'node:process';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Database } from '../../src/infrastructure/database/database';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/wager-transaction';
import { ProcessWager } from '../../src/application/use-cases/process-wager';
import { MikroOrmFinancialUnitOfWork } from '../../src/infrastructure/database/financial-unit-of-work';
import { FinancialMetrics } from '../../src/infrastructure/database/financial-metrics';
import { Telemetry } from '../../src/observability/telemetry';
import {
  createOperationalContext,
  spawnWorker,
} from '../support/operational-context';

const { db, services, request, assertBalance } = createOperationalContext();

test('durable financial metrics count background transitions and ignore replays', async () => {
  const { wallet, data } = await request();
  const metrics = new FinancialMetrics(db);
  const before = await metrics.collect();
  const refund = {
    ...data,
    externalTransactionId: randomUUID(),
    kind: Kind.Refund,
    referenceExternalTransactionId: data.externalTransactionId,
  };
  const pending = await services.submit(refund, refund.externalTransactionId);
  await services.submit(data, data.externalTransactionId);
  for (let i = 0; i < 3; i++)
    await services.submit(data, data.externalTransactionId);
  await db.orm.em
    .fork()
    .execute(
      "UPDATE wager_transactions SET next_attempt_at=now()-interval '1 second' WHERE id=?",
      [pending.transactionId],
    );
  const child = spawnWorker('reference', [pending.transactionId]);
  expect(await child.exited).toBe(0);
  const after = await new FinancialMetrics(db).collect();
  expect(
    after[Status.Processed].current - before[Status.Processed].current,
  ).toBe(2);
  expect(
    after[Status.Processed].transitions - before[Status.Processed].transitions,
  ).toBe(2);
  expect(after[Status.PendingReference].current).toBe(
    before[Status.PendingReference].current,
  );
  expect(
    after[Status.PendingReference].transitions -
      before[Status.PendingReference].transitions,
  ).toBe(1);
  await assertBalance(wallet.id, '100.00');
});

test('real financial lock timeout is counted once for HTTP and worker use cases alike', async () => {
  const { wallet, data } = await request();
  const originalTimeout = process.env.PG_LOCK_TIMEOUT_MS;
  const contender = new Database();
  try {
    process.env.PG_LOCK_TIMEOUT_MS = '50';
    await contender.onModuleInit();
  } finally {
    if (originalTimeout === undefined) delete process.env.PG_LOCK_TIMEOUT_MS;
    else process.env.PG_LOCK_TIMEOUT_MS = originalTimeout;
  }
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
  const telemetry = new Telemetry();
  try {
    const processor = new ProcessWager(
      new MikroOrmFinancialUnitOfWork(contender, telemetry),
    );
    await expect(
      processor.execute(data, data.externalTransactionId),
    ).rejects.toThrow();
    expect(telemetry.render()).toContain('jungle_lock_conflicts_total 1\n');
  } finally {
    release();
    await lock;
    await contender.onApplicationShutdown();
  }
  await expect(
    services.transactionByExternalId(
      data.providerId,
      data.externalTransactionId,
    ),
  ).rejects.toThrow();
  await assertBalance(wallet.id, '100.00');
});
