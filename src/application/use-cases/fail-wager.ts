import {
  FinancialUnitOfWork,
  TransactionResult,
} from '../ports/financial-unit-of-work';
import { InboxContext } from './process-wager';
import { WagerInput } from '../contracts';
import { createWager } from '../create-wager';
import { ResourceNotFoundError } from '../errors';
import { InboxMessage } from '../../domain/delivery';
import { DomainError } from '../../domain/domain-error';
import { transactionOutcome } from '../wager-events';
/** Quarantine a valid command after processing retries are exhausted. Never undo a commit. */
export class FailWager {
  constructor(private readonly uow: FinancialUnitOfWork) {}
  async execute(
    input: WagerInput,
    key: string,
    inbox: InboxContext,
  ): Promise<TransactionResult> {
    const candidate = createWager(input, key);
    return this.uow.run(async (session) => {
      await session.inbox.receive(
        InboxMessage.receive({
          ...inbox,
          payloadHash: inbox.hash,
          receivedAt: new Date(),
        }),
      );
      if (!(await session.wallets.exists(candidate.walletId)))
        throw new ResourceNotFoundError('Wallet');
      let tx = candidate;
      if (!(await session.transactions.reserve(tx))) {
        const stored = await session.transactions.findConflicts(tx);
        const existing = stored[0];
        if (
          stored.length !== 1 ||
          !existing ||
          !existing.transaction.matchesPayload(tx.payloadHash) ||
          existing.transaction.idempotencyKey !== key
        ) {
          throw new DomainError('IDEMPOTENCY_CONFLICT');
        }
        if (existing.result) {
          await session.inbox.complete(inbox.consumerName, inbox.messageId);
          return { ...existing.result, idempotentReplay: true };
        }
        if (existing.transaction.isTerminal())
          throw new Error('Terminal transaction without result');
        tx = existing.transaction;
      }
      const wallet = await session.wallets.lock(tx.walletId);
      if (!wallet) throw new ResourceNotFoundError('Wallet');
      if (wallet.playerId !== tx.playerId) tx.reject('INVALID_TRANSACTION');
      else if (wallet.currency !== tx.money.currency)
        tx.reject('CURRENCY_MISMATCH');
      else tx.fail('INFRASTRUCTURE_RETRY_EXHAUSTED');
      const result: TransactionResult = {
        transactionId: tx.id,
        status: tx.status,
        balance: wallet.balance.toJSON(),
        failureCode: tx.failureCode,
        idempotentReplay: false,
      };
      await session.transactions.save(tx, result, 0, new Date());
      await session.outbox.enqueue(transactionOutcome(tx));
      await session.inbox.complete(inbox.consumerName, inbox.messageId);
      return result;
    });
  }
}
