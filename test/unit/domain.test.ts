import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../src/domain/ledger-entry';
import {
  WagerTransaction as Tx,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/wager-transaction';
import { canonicalJson, payloadHash } from '../../src/domain/payload-hash';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00Z');
const props = {
  id: 'tx',
  providerId: 'provider',
  externalTransactionId: 'external',
  idempotencyKey: 'provider:external',
  payloadHash: 'hash',
  walletId: 'wallet',
  playerId: 'player',
  roundId: 'round',
  gameId: 'game',
  kind: Kind.Bet,
  money: brl('25.00'),
  createdAt: at,
};
const processedBet = () => {
  const tx = Tx.create(props);
  tx.markProcessed(undefined, at, LedgerDirection.Debit);
  return tx;
};

describe('Money', () => {
  test('arithmetic is exact, immutable and serializes fixed scale', () => {
    const a = brl('0.10');
    expect(a.add(brl('0.20')).toString()).toBe('0.30');
    expect(a.toString()).toBe('0.10');
    expect(a.subtract(brl('0.20')).toJSON()).toEqual({
      amount: '-0.10',
      currency: 'BRL',
    });
    expect(a.negate().negate().equals(a)).toBe(true);
    expect(brl('999999999999999999.98').add(brl('0.01')).toString()).toBe(
      '999999999999999999.99',
    );
  });
  test.each([
    '',
    '1',
    '1.0',
    ' ',
    'NaN',
    'Infinity',
    '-1',
    '-0.00',
    '1e2',
    '1.001',
    '1.',
    '.1',
    '+1',
    '1,00',
    ' 1.00',
    '1000000000000000000.00',
  ])('rejects invalid amount %s without rounding', (amount) => {
    expect(() => brl(amount)).toThrow();
  });
  test('rejects numeric contracts, invalid currency, overflow and mixed currencies', () => {
    expect(() =>
      Money.from({ amount: 1 as unknown as string, currency: 'BRL' }),
    ).toThrow();
    expect(() => Money.zero('brl')).toThrow();
    expect(() => brl('999999999999999999.99').add(brl('0.01'))).toThrow();
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    for (const op of ['add', 'subtract', 'equals', 'isLessThan'] as const) {
      expect(() => brl('1.00')[op](usd)).toThrow('CURRENCY_MISMATCH');
    }
  });
});

describe('Wallet and ledger', () => {
  const open = () =>
    Wallet.open({
      id: 'wallet',
      playerId: 'player',
      initialBalance: brl('100.00'),
      at,
    });
  const ctx = { entryId: 'entry', transactionId: 'tx', at };
  test('opening version is one; debit and credit return balanced entries', () => {
    const wallet = open();
    expect(wallet.version).toBe(1);
    const debit = wallet.debit(brl('80.00'), ctx);
    expect(debit.isBalanced()).toBe(true);
    expect(debit.balanceBefore.toString()).toBe('100.00');
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    wallet.credit(brl('5.00'), {
      ...ctx,
      entryId: 'entry2',
      transactionId: 'tx2',
    });
    expect(wallet.balance.toString()).toBe('25.00');
    expect(wallet.version).toBe(3);
  });
  test('failed movements leave balance and version unchanged', () => {
    const wallet = open();
    expect(() => wallet.debit(brl('101.00'), ctx)).toThrow(
      'INSUFFICIENT_FUNDS',
    );
    expect(() =>
      wallet.debit(brl('101.00'), { ...ctx, reversal: true }),
    ).toThrow('REVERSAL_INSUFFICIENT_FUNDS');
    expect(() => wallet.credit(brl('0.00'), ctx)).toThrow();
    expect(() => wallet.credit(Money.zero('USD'), ctx)).toThrow(
      'CURRENCY_MISMATCH',
    );
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });
  test('ledger rejects unbalanced entries and protects Date references', () => {
    const wallet = open();
    const entry = wallet.debit(brl('1.00'), ctx);
    entry.createdAt.setFullYear(2000);
    expect(entry.createdAt.getUTCFullYear()).toBe(2026);
    expect(() =>
      WalletLedgerEntry.create({
        id: 'bad',
        walletId: 'wallet',
        transactionId: 'tx',
        direction: LedgerDirection.Debit,
        money: brl('5.00'),
        balanceBefore: brl('10.00'),
        balanceAfter: brl('9.00'),
        createdAt: at,
      }),
    ).toThrow();
  });
});

describe('WagerTransaction', () => {
  test.each([Kind.Bet, Kind.Win, Kind.Loss])('models %s explicitly', (kind) => {
    const tx = Tx.create({ ...props, kind });
    expect(tx.status).toBe(Status.Pending);
    expect(tx.affectsBalance()).toBe(kind !== Kind.Loss);
    if (kind !== Kind.Loss)
      expect(tx.ledgerDirectionFor()).toBe(
        kind === Kind.Bet ? LedgerDirection.Debit : LedgerDirection.Credit,
      );
    tx.markProcessed(
      undefined,
      at,
      kind === Kind.Loss ? undefined : tx.ledgerDirectionFor(),
    );
    expect(tx.isTerminal()).toBe(true);
  });
  test.each([Kind.Refund, Kind.Rollback])(
    '%s requires a full matching processed reference',
    (kind) => {
      expect(() => Tx.create({ ...props, kind })).toThrow('INVALID_REFERENCE');
      const tx = Tx.create({
        ...props,
        id: 'reversal',
        externalTransactionId: 'reverse',
        kind,
        referenceExternalTransactionId: 'external',
      });
      tx.markPendingReference();
      expect(tx.status).toBe(Status.PendingReference);
      expect(tx.ledgerDirectionFor(processedBet())).toBe(
        LedgerDirection.Credit,
      );
      tx.markProcessed('tx', at, LedgerDirection.Credit);
      expect(tx.referenceTransactionId).toBe('tx');
    },
  );
  test('rollback of WIN is debit; insufficient reversal balance is distinct', () => {
    const win = Tx.create({ ...props, kind: Kind.Win });
    win.markProcessed(undefined, at, LedgerDirection.Credit);
    const rollback = Tx.create({
      ...props,
      kind: Kind.Rollback,
      externalTransactionId: 'reverse',
      referenceExternalTransactionId: 'external',
    });
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
  });
  test('validates reference identity, currency, amount, kind and terminal status', () => {
    const reverse = Tx.create({
      ...props,
      kind: Kind.Refund,
      externalTransactionId: 'reverse',
      referenceExternalTransactionId: 'external',
    });
    for (const change of [
      { providerId: 'other' },
      { playerId: 'other' },
      { walletId: 'other' },
      { roundId: 'other' },
      { money: brl('24.00') },
      { kind: Kind.Win },
      { money: Money.from({ amount: '25.00', currency: 'USD' }) },
    ]) {
      const ref = Tx.create({ ...props, ...change });
      ref.markProcessed(undefined, at, ref.ledgerDirectionFor());
      expect(() => reverse.validateReference(ref)).toThrow();
    }
    expect(() => reverse.validateReference(Tx.create(props))).toThrow(
      'REFERENCE_NOT_PROCESSED',
    );
  });
  test.each([Status.Processed, Status.Rejected, Status.Failed])(
    '%s cannot transition again',
    (status) => {
      const tx = Tx.create(props);
      if (status === Status.Processed)
        tx.markProcessed(undefined, at, LedgerDirection.Debit);
      else if (status === Status.Rejected) tx.reject('INSUFFICIENT_FUNDS');
      else tx.fail('REFERENCE_NOT_FOUND');
      expect(() =>
        tx.markProcessed(undefined, at, LedgerDirection.Debit),
      ).toThrow('INVALID_TRANSACTION_STATE');
      expect(() => tx.markPendingReference()).toThrow(
        'INVALID_TRANSACTION_STATE',
      );
      expect(() => tx.reject('INVALID_REFERENCE')).toThrow(
        'INVALID_TRANSACTION_STATE',
      );
      expect(() => tx.fail('INVALID_REFERENCE')).toThrow(
        'INVALID_TRANSACTION_STATE',
      );
    },
  );
  test('rehydration reconstructs persisted state without replaying transitions', () => {
    const tx = Tx.rehydrate({
      ...props,
      status: Status.Rejected,
      failureCode: 'INSUFFICIENT_FUNDS',
    });
    expect(tx.failureCode).toBe('INSUFFICIENT_FUNDS');
  });
  test('canonical hash ignores key order but detects divergent payloads', () => {
    expect(canonicalJson({ z: 1, a: { c: 2, b: 'x' } })).toBe(
      '{"a":{"b":"x","c":2},"z":1}',
    );
    const hash = payloadHash({
      walletId: 'wallet',
      money: brl('25.00').toJSON(),
    });
    const tx = Tx.create({ ...props, payloadHash: hash });
    expect(
      tx.matchesPayload(
        payloadHash({ money: brl('25.00').toJSON(), walletId: 'wallet' }),
      ),
    ).toBe(true);
    expect(
      tx.matchesPayload(
        payloadHash({ money: brl('26.00').toJSON(), walletId: 'wallet' }),
      ),
    ).toBe(false);
  });
});

test('BET cannot be marked processed with a credit direction', () => {
  const tx = Tx.create(props);
  expect(() => tx.markProcessed(undefined, at, LedgerDirection.Credit)).toThrow(
    'INVALID_TRANSACTION',
  );
  expect(tx.status).toBe(Status.Pending);
});
