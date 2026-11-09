import { FinancialMetrics } from '../../src/infrastructure/database/financial-metrics';
import { DomainInvariantError } from '../../src/domain/domain-error';
import { ProcessWager } from '../../src/application/use-cases/process-wager';
import {
  FinancialUnitOfWork,
  FinancialSession,
} from '../../src/application/ports/financial-unit-of-work';
import { MikroOrmFinancialUnitOfWork } from '../../src/infrastructure/database/financial-unit-of-work';
import { beforeAll, afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Database } from '../../src/infrastructure/database/database';
import { createServices } from '../support/create-services';
import { WagerInput } from '../../src/application/contracts';
import { Money } from '../../src/domain/money';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/wager-transaction';

const db = new Database();
let service: ReturnType<typeof createServices>;
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
beforeAll(async () => {
  await db.onModuleInit();
  await db.orm.migrator.up();
  service = createServices(db);
});
afterAll(async () => {
  await db.onApplicationShutdown();
});
async function setup(amount = '100.00') {
  const wallet = await service.openWallet(randomUUID(), brl(amount));
  const input: WagerInput = {
    providerId: 'test',
    externalTransactionId: randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round',
    gameId: 'game',
    kind: Kind.Bet,
    money: brl('80.00').toJSON(),
  };
  return { wallet, input };
}
async function consistent(id: string, expected: string) {
  const result = await service.reconcile(id);
  expect(result.consistent).toBe(true);
  expect(result.storedBalance.amount).toBe(expected);
}
test('two simultaneous bets of 80: exactly one debit and balance 20', async () => {
  const { wallet, input } = await setup();
  const results = await Promise.all([
    service.submit(input, input.externalTransactionId),
    service.submit(
      { ...input, externalTransactionId: randomUUID() },
      randomUUID(),
    ),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([
    Status.Processed,
    Status.Rejected,
  ]);
  expect(results.find((r) => r.status === 'REJECTED')!.failureCode).toBe(
    'INSUFFICIENT_FUNDS',
  );
  const ledger = await service.ledger(wallet.id, undefined, 50);
  expect(ledger.items.filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
  await consistent(wallet.id, '20.00');
});
test('50 concurrent duplicates debit once, replay retains historical balance', async () => {
  const { wallet, input } = await setup();
  const results = await Promise.all(
    Array.from({ length: 50 }, () =>
      service.submit(input, input.externalTransactionId),
    ),
  );
  expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
  expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
  const win = {
    ...input,
    externalTransactionId: randomUUID(),
    kind: Kind.Win,
    money: brl('10.00').toJSON(),
  };
  await service.submit(win, win.externalTransactionId);
  const replay = await service.submit(input, input.externalTransactionId);
  expect(replay.balance.amount).toBe('20.00');
  await expect(
    service.submit(
      { ...input, money: brl('1.00').toJSON() },
      input.externalTransactionId,
    ),
  ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  await consistent(wallet.id, '30.00');
});
test('refund before bet waits then processes exactly once; same-type second reversal rejected', async () => {
  const { wallet, input } = await setup();
  const refund = {
    ...input,
    externalTransactionId: randomUUID(),
    kind: Kind.Refund,
    referenceExternalTransactionId: input.externalTransactionId,
  };
  const pending = await service.submit(refund, refund.externalTransactionId);
  expect(pending.status).toBe(Status.PendingReference);
  await service.submit(input, input.externalTransactionId);
  await db.orm.em
    .fork()
    .execute(
      "UPDATE wager_transactions SET next_attempt_at=now()-interval '1 second' WHERE id=?",
      [pending.transactionId],
    );
  await Promise.all([
    service.retryPending(pending.transactionId),
    service.retryPending(pending.transactionId),
  ]);
  expect((await service.transactionById(pending.transactionId)).status).toBe(
    Status.Processed,
  );
  const second = await service.submit(
    { ...refund, externalTransactionId: randomUUID() },
    randomUUID(),
  );
  expect(second.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
  await consistent(wallet.id, '100.00');
});
test('LOSS produces no ledger or version increment; rollback of spent WIN rejected', async () => {
  const { wallet, input } = await setup('0.00');
  const win = { ...input, kind: Kind.Win, money: brl('10.00').toJSON() };
  await service.submit(win, win.externalTransactionId);
  await service.submit(
    {
      ...input,
      externalTransactionId: randomUUID(),
      money: brl('10.00').toJSON(),
    },
    randomUUID(),
  );
  const rollback = await service.submit(
    {
      ...input,
      externalTransactionId: randomUUID(),
      kind: Kind.Rollback,
      money: brl('10.00').toJSON(),
      referenceExternalTransactionId: win.externalTransactionId,
    },
    randomUUID(),
  );
  expect(rollback.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
  const before = await service.getWallet(wallet.id);
  const loss = await service.submit(
    {
      ...input,
      externalTransactionId: randomUUID(),
      kind: Kind.Loss,
      money: brl('0.00').toJSON(),
    },
    randomUUID(),
  );
  expect(loss.status).toBe(Status.Processed);
  expect((await service.getWallet(wallet.id)).version).toBe(before.version);
  await consistent(wallet.id, '0.00');
});
test('inbox deduplicates and rejects messageId with changed payload hash', async () => {
  const { wallet, input } = await setup();
  const inbox = {
    messageId: randomUUID(),
    consumerName: 'test',
    hash: 'a'.repeat(64),
  };
  await service.submit(input, input.externalTransactionId, inbox);
  expect(
    (await service.submit(input, input.externalTransactionId, inbox))
      .idempotentReplay,
  ).toBe(true);
  await expect(
    service.submit(input, input.externalTransactionId, {
      ...inbox,
      hash: 'b'.repeat(64),
    }),
  ).rejects.toThrow();
  await consistent(wallet.id, '20.00');
});
test('database rejects ledger mutation, negative balance and wallet/ledger divergence', async () => {
  const { wallet } = await setup();
  const em = db.orm.em.fork();
  await expect(
    em.execute('UPDATE wallet_ledger SET amount=amount WHERE wallet_id=?', [
      wallet.id,
    ]),
  ).rejects.toThrow('append-only');
  await expect(
    em.execute('DELETE FROM wallet_ledger WHERE wallet_id=?', [wallet.id]),
  ).rejects.toThrow('append-only');
  await expect(
    em.execute('UPDATE wallets SET balance=-1 WHERE id=?', [wallet.id]),
  ).rejects.toThrow();
  await expect(
    em.transactional(async (tx) => {
      await tx.execute(
        'UPDATE wallets SET balance=99,version=version+1 WHERE id=?',
        [wallet.id],
      );
    }),
  ).rejects.toThrow('wallet/ledger mismatch');
  await consistent(wallet.id, '100.00');
});
test('failure inserting outbox rolls back wallet, transaction, ledger and inbox', async () => {
  const { wallet, input } = await setup();
  const inbox = {
    messageId: randomUUID(),
    consumerName: 'atomicity',
    hash: 'a'.repeat(64),
  };
  const failing = new ProcessWager(
    new OutboxFailureUnitOfWork(new MikroOrmFinancialUnitOfWork(db)),
  );
  await expect(
    failing.execute(input, input.externalTransactionId, inbox),
  ).rejects.toThrow('outbox write failed');
  const rows = await db.orm.em
    .fork()
    .execute('SELECT * FROM inbox WHERE message_id=?', [inbox.messageId]);
  expect(rows).toHaveLength(0);
  await expect(
    service.transactionByExternalId(
      input.providerId,
      input.externalTransactionId,
    ),
  ).rejects.toThrow();
  await consistent(wallet.id, '100.00');
});
test('wallets are independent: a locked wallet does not block another wallet', async () => {
  const first = await setup();
  const second = await setup();
  let unlock!: () => void;
  let announce!: () => void;
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const locked = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const blocker = db.orm.em.fork().transactional(async (em) => {
    await em.execute('SELECT id FROM wallets WHERE id=? FOR UPDATE', [
      first.wallet.id,
    ]);
    announce();
    await gate;
  });
  await locked;
  try {
    const result = await service.submit(
      second.input,
      second.input.externalTransactionId,
    );
    expect(result.status).toBe(Status.Processed);
    await consistent(second.wallet.id, '20.00');
  } finally {
    unlock();
    await blocker;
  }
  await consistent(first.wallet.id, '100.00');
});
test('unresolved reference exhausts persistent attempts and emits a rejection', async () => {
  const { wallet, input } = await setup();
  const result = await service.submit(
    {
      ...input,
      kind: Kind.Rollback,
      referenceExternalTransactionId: randomUUID(),
    },
    randomUUID(),
  );
  await db.orm.em
    .fork()
    .execute(
      "UPDATE wager_transactions SET attempts=10,next_attempt_at=now()-interval '1 second' WHERE id=?",
      [result.transactionId],
    );
  await service.retryPending(result.transactionId);
  const final = await service.transactionById(result.transactionId);
  expect(final.status).toBe(Status.Rejected);
  expect('failureCode' in final && final.failureCode).toBe(
    'REFERENCE_NOT_FOUND',
  );
  const events = await db.orm.em
    .fork()
    .execute(
      `SELECT id FROM outbox WHERE event_type='WagerTransactionRejected' AND payload->'data'->>'transactionId'=?`,
      [result.transactionId],
    );
  expect(events).toHaveLength(1);
  await consistent(wallet.id, '100.00');
});

class OutboxFailureUnitOfWork extends FinancialUnitOfWork {
  constructor(private readonly delegate: FinancialUnitOfWork) {
    super();
  }
  run<T>(work: (session: FinancialSession) => Promise<T>): Promise<T> {
    return this.delegate.run((session) =>
      work({
        ...session,
        outbox: {
          enqueue: async () => {
            throw new Error('outbox write failed');
          },
        },
      }),
    );
  }
}

test('internal invariant failure inside processing aborts instead of becoming REJECTED', async () => {
  const { wallet, input } = await setup();
  const inbox = {
    messageId: randomUUID(),
    consumerName: 'invariant-regression',
    hash: 'a'.repeat(64),
  };
  const failure = new DomainInvariantError('INVALID_TRANSACTION_STATE');
  const brokenReferences = new ReferenceFailureUnitOfWork(
    new MikroOrmFinancialUnitOfWork(db),
    failure,
  );
  const processor = new ProcessWager(brokenReferences);
  const refund = {
    ...input,
    kind: Kind.Refund,
    referenceExternalTransactionId: randomUUID(),
  };
  await expect(
    processor.execute(refund, input.externalTransactionId, inbox),
  ).rejects.toBe(failure);
  await expect(
    service.transactionByExternalId(
      input.providerId,
      input.externalTransactionId,
    ),
  ).rejects.toThrow();
  const em = db.orm.em.fork();
  expect(
    await em.execute('SELECT * FROM inbox WHERE message_id=?', [
      inbox.messageId,
    ]),
  ).toHaveLength(0);
  expect(
    await em.execute(
      `SELECT * FROM outbox WHERE payload->'data'->>'transactionId' IN
    (SELECT id::text FROM wager_transactions WHERE external_transaction_id=?)`,
      [input.externalTransactionId],
    ),
  ).toHaveLength(0);
  await consistent(wallet.id, '100.00');
});
class ReferenceFailureUnitOfWork extends FinancialUnitOfWork {
  constructor(
    private readonly delegate: FinancialUnitOfWork,
    private readonly error: Error,
  ) {
    super();
  }
  run<T>(work: (session: FinancialSession) => Promise<T>): Promise<T> {
    return this.delegate.run((session) =>
      work({
        ...session,
        transactions: {
          reserve: session.transactions.reserve.bind(session.transactions),
          findConflicts: session.transactions.findConflicts.bind(
            session.transactions,
          ),
          lockDue: session.transactions.lockDue.bind(session.transactions),
          hasReversal: session.transactions.hasReversal.bind(
            session.transactions,
          ),
          save: session.transactions.save.bind(session.transactions),
          findReference: async () => {
            throw this.error;
          },
        },
      }),
    );
  }
}

test('outbox metrics reflect persisted publication without a publisher gauge callback', async () => {
  const metrics = new FinancialMetrics(db);
  const baseline = await metrics.outboxSnapshot();
  const { wallet } = await setup();
  const pending = await metrics.outboxSnapshot();
  expect(pending.pending).toBe(baseline.pending + 2);
  expect(pending.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(0);
  // Isolate the observation from process-local telemetry: publication state is the source of truth.
  await db.orm.em
    .fork()
    .execute('UPDATE outbox SET published_at=now() WHERE aggregate_id=?', [
      wallet.id,
    ]);
  expect((await metrics.outboxSnapshot()).pending).toBe(baseline.pending);
  expect(await metrics.render()).toContain(
    'jungle_outbox_oldest_pending_age_seconds',
  );
  await consistent(wallet.id, '100.00');
});
