import { randomUUID } from 'node:crypto';
import {
  FinancialUnitOfWork,
  FinancialSession,
  TransactionResult,
} from '../ports/financial-unit-of-work';
import { ResourceNotFoundError } from '../errors';
import { ReferenceRetryPolicy } from '../reference-retry-policy';
import { WagerInput } from '../contracts';
import {
  WagerTransaction,
  WagerTransactionStatus as Status,
} from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/ledger-entry';
import { InboxMessage } from '../../domain/delivery';
import { DomainError, isBusinessRejection } from '../../domain/domain-error';
import { createWager } from '../create-wager';
import { balanceChanged, transactionOutcome } from '../wager-events';
export interface InboxContext {
  messageId: string;
  consumerName: string;
  hash: string;
}
export class ProcessWager {
  constructor(
    private readonly uow: FinancialUnitOfWork,
    private readonly retries = new ReferenceRetryPolicy(),
  ) {}
  async execute(
    input: WagerInput,
    key: string,
    inbox?: InboxContext,
  ): Promise<TransactionResult> {
    const tx = createWager(input, key);
    return this.uow.run(async (session) => {
      if (inbox)
        await session.inbox.receive(
          InboxMessage.receive({
            ...inbox,
            payloadHash: inbox.hash,
            receivedAt: new Date(),
          }),
        );
      if (!(await session.wallets.exists(tx.walletId)))
        throw new ResourceNotFoundError('Wallet');
      const result = (await session.transactions.reserve(tx))
        ? await this.apply(session, tx)
        : await this.replay(session, tx);
      if (inbox)
        await session.inbox.complete(inbox.consumerName, inbox.messageId);
      return result;
    });
  }
  async retryPending(id: string): Promise<boolean> {
    return this.uow.run(async (session) => {
      const stored = await session.transactions.lockDue(id);
      if (!stored || stored.transaction.status !== Status.PendingReference)
        return false;
      await this.apply(session, stored.transaction, stored.attempts);
      return true;
    });
  }
  private async replay(
    session: FinancialSession,
    tx: WagerTransaction,
  ): Promise<TransactionResult> {
    const existing = await session.transactions.findConflicts(tx);
    const stored = existing[0];
    if (
      existing.length !== 1 ||
      !stored ||
      !stored.transaction.matchesPayload(tx.payloadHash) ||
      stored.transaction.idempotencyKey !== tx.idempotencyKey
    ) {
      throw new DomainError('IDEMPOTENCY_CONFLICT');
    }
    if (!stored.result) throw new Error('Transaction committed without result');
    return { ...stored.result, idempotentReplay: true };
  }
  private async apply(
    session: FinancialSession,
    tx: WagerTransaction,
    attempts = 0,
  ): Promise<TransactionResult> {
    const wallet = await session.wallets.lock(tx.walletId);
    if (!wallet) throw new ResourceNotFoundError('Wallet');
    let entry: WalletLedgerEntry | undefined;
    try {
      if (wallet.playerId !== tx.playerId)
        throw new DomainError('INVALID_TRANSACTION');
      if (wallet.currency !== tx.money.currency)
        throw new DomainError('CURRENCY_MISMATCH');
      const reference = await this.resolveReference(session, tx, attempts);
      if (
        !tx.isTerminal() &&
        (!tx.referenceExternalTransactionId || reference)
      ) {
        entry = this.move(wallet, tx, reference);
        tx.markProcessed(reference?.id, new Date(), entry?.direction);
      }
    } catch (error) {
      if (!isBusinessRejection(error)) throw error;
      // An error after a mutation is an internal failure: roll back rather than commit a rejected movement.
      if (entry) throw error;
      tx.reject(error.code);
    }
    if (entry) {
      await session.wallets.save(wallet);
      await session.ledger.append(entry);
      await session.outbox.enqueue(balanceChanged(wallet, entry));
    }
    const result: TransactionResult = {
      transactionId: tx.id,
      status: tx.status,
      balance: wallet.balance.toJSON(),
      ...(tx.failureCode && { failureCode: tx.failureCode }),
      idempotentReplay: false,
    };
    await session.transactions.save(
      tx,
      result,
      attempts + 1,
      this.retries.nextAttempt(attempts, new Date()),
    );
    if (tx.status !== Status.PendingReference || attempts === 0)
      await session.outbox.enqueue(transactionOutcome(tx));
    return result;
  }
  private async resolveReference(
    session: FinancialSession,
    tx: WagerTransaction,
    attempts: number,
  ): Promise<WagerTransaction | undefined> {
    if (!tx.referenceExternalTransactionId) return undefined;
    const reference = await session.transactions.findReference(
      tx.providerId,
      tx.referenceExternalTransactionId,
    );
    if (
      !reference ||
      [Status.Pending, Status.PendingReference].includes(reference.status)
    ) {
      if (this.retries.exhausted(attempts, tx.createdAt, new Date()))
        tx.reject('REFERENCE_NOT_FOUND');
      else tx.markPendingReference();
      return undefined;
    }
    tx.validateReference(reference);
    if (
      tx.requiresReference() &&
      (await session.transactions.hasReversal(reference.id, tx.kind))
    )
      throw new DomainError('REFERENCE_ALREADY_REVERSED');
    return reference;
  }
  private move(
    wallet: Wallet,
    tx: WagerTransaction,
    reference?: WagerTransaction,
  ): WalletLedgerEntry | undefined {
    if (!tx.affectsBalance()) return undefined;
    const ctx = {
      entryId: randomUUID(),
      transactionId: tx.id,
      at: new Date(),
      reversal: tx.requiresReference(),
    };
    return tx.ledgerDirectionFor(reference) === LedgerDirection.Debit
      ? wallet.debit(tx.money, ctx)
      : wallet.credit(tx.money, ctx);
  }
}
