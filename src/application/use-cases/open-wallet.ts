import { randomUUID } from 'node:crypto';
import {
  FinancialUnitOfWork,
  TransactionResult,
} from '../ports/financial-unit-of-work';
import { Wallet } from '../../domain/wallet';
import { Money } from '../../domain/money';
import { WalletLedgerEntry, LedgerDirection } from '../../domain/ledger-entry';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
} from '../../domain/wager-transaction';
import { payloadHash } from '../../domain/payload-hash';
import { balanceChanged, transactionOutcome } from '../wager-events';
export class OpenWallet {
  constructor(private readonly uow: FinancialUnitOfWork) {}
  async execute(playerId: string, initialBalance: Money) {
    return this.uow.run(async (session) => {
      const now = new Date();
      const wallet = Wallet.open({
        id: randomUUID(),
        playerId,
        initialBalance,
        at: now,
      });
      await session.wallets.create(wallet);
      if (initialBalance.isPositive()) {
        const id = randomUUID();
        const tx = WagerTransaction.create({
          id,
          providerId: 'internal',
          externalTransactionId: id,
          idempotencyKey: `opening:${wallet.id}`,
          payloadHash: payloadHash({ walletId: wallet.id }),
          walletId: wallet.id,
          playerId,
          roundId: 'opening',
          gameId: 'internal',
          kind: Kind.Opening,
          money: initialBalance,
          createdAt: now,
        });
        if (!(await session.transactions.reserve(tx)))
          throw new Error('Opening transaction identity collision');
        tx.markProcessed(undefined, now, LedgerDirection.Credit);
        const result: TransactionResult = {
          transactionId: id,
          status: tx.status,
          balance: wallet.balance.toJSON(),
          idempotentReplay: false,
        };
        await session.transactions.save(tx, result, 0, now);
        const entry = WalletLedgerEntry.create({
          id: randomUUID(),
          walletId: wallet.id,
          transactionId: id,
          direction: LedgerDirection.Credit,
          money: initialBalance,
          balanceBefore: Money.zero(wallet.currency),
          balanceAfter: initialBalance,
          createdAt: now,
        });
        await session.ledger.append(entry);
        await session.outbox.enqueue(transactionOutcome(tx));
        await session.outbox.enqueue(balanceChanged(wallet, entry));
      }
      return {
        id: wallet.id,
        playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }
}
