import { randomUUID } from 'node:crypto';
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry } from '../domain/ledger-entry';
import {
  WalletBalanceChanged,
  WagerTransactionProcessed,
  WagerTransactionFailed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
} from '../domain/integration-event';
import {
  WagerTransaction,
  WagerTransactionStatus as Status,
} from '../domain/wager-transaction';
export function eventContext(walletId: string, transactionId: string) {
  return {
    eventId: randomUUID(),
    aggregateId: walletId,
    correlationId: transactionId,
    causationId: transactionId,
    occurredAt: new Date(),
  };
}
export function balanceChanged(wallet: Wallet, entry: WalletLedgerEntry) {
  return WalletBalanceChanged.create(
    eventContext(wallet.id, entry.transactionId),
    {
      walletId: wallet.id,
      transactionId: entry.transactionId,
      direction: entry.direction,
      money: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      walletVersion: wallet.version,
    },
  );
}
export function transactionOutcome(tx: WagerTransaction) {
  const Event =
    tx.status === Status.Failed
      ? WagerTransactionFailed
      : tx.status === Status.Processed
        ? WagerTransactionProcessed
        : tx.status === Status.Rejected
          ? WagerTransactionRejected
          : WagerTransactionPendingReference;
  return Event.create(eventContext(tx.walletId, tx.id), {
    transactionId: tx.id,
    walletId: tx.walletId,
    providerId: tx.providerId,
    status: tx.status,
    ...(tx.failureCode && { failureCode: tx.failureCode }),
  });
}
