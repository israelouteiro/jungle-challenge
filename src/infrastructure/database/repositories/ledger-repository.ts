import { EntityManager } from '@mikro-orm/postgresql';
import { LedgerRepository } from '../../../application/ports/financial-unit-of-work';
import { WalletLedgerEntry } from '../../../domain/ledger-entry';

export class SqlLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}
  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.execute(
      `INSERT INTO wallet_ledger(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.direction,
        entry.money.toString(),
        entry.money.currency,
        entry.balanceBefore.toString(),
        entry.balanceAfter.toString(),
        entry.createdAt,
      ],
    );
  }
}
