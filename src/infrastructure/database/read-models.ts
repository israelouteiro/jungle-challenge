import { Injectable } from '@nestjs/common';
import { LockMode } from '@mikro-orm/core';
import { Telemetry } from '../../observability/telemetry';
import { Database } from './database';
import { WalletRecord } from './wallet-record';
import { TransactionRow } from './transaction-mapper';
import { ResourceNotFoundError } from '../../application/errors';
import {
  WalletReadPort,
  TransactionReadPort,
} from '../../application/ports/read-models';
import { DomainError } from '../../domain/domain-error';
import { LedgerDirection } from '../../domain/ledger-entry';
interface LedgerRow {
  sequence: string;
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: LedgerDirection;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date;
}
@Injectable()
export class SqlWalletReadModel implements WalletReadPort {
  constructor(
    private readonly db: Database,
    private readonly telemetry: Telemetry = new Telemetry(),
  ) {}
  async getWallet(id: string) {
    const row = await this.db.orm.em.fork().findOne(WalletRecord, { id });
    if (!row) throw new ResourceNotFoundError('Wallet');
    return {
      id: row.id,
      playerId: row.playerId,
      balance: { amount: row.balance, currency: row.currency },
      version: row.version,
    };
  }
  async reconciliationSnapshot(id: string) {
    try {
      return await this.db.orm.em.fork().transactional(async (em) => {
        const row = await em.findOne(
          WalletRecord,
          { id },
          { lockMode: LockMode.PESSIMISTIC_READ },
        );
        if (!row) throw new ResourceNotFoundError('Wallet');
        const [totals] = await em.execute<{ amount: string; count: string }[]>(
          `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END),0)::text AS amount, COUNT(*)::text AS count FROM wallet_ledger WHERE wallet_id=?`,
          [id],
        );
        return {
          wallet: {
            id: row.id,
            playerId: row.playerId,
            balance: { amount: row.balance, currency: row.currency },
            version: row.version,
          },
          calculatedBalance: { amount: totals!.amount, currency: row.currency },
          checkedEntries: Number(totals!.count),
        };
      });
    } catch (error) {
      this.telemetry.recordLockConflict(error);
      throw error;
    }
  }
  async ledger(id: string, cursor: string | undefined, limit: number) {
    await this.getWallet(id);
    let sequence = '0';
    if (cursor) {
      try {
        const decoded = JSON.parse(
          Buffer.from(cursor, 'base64url').toString(),
        ) as { walletId: string; sequence: string };
        if (
          decoded.walletId !== id ||
          typeof decoded.sequence !== 'string' ||
          !/^\d{1,19}$/.test(decoded.sequence) ||
          BigInt(decoded.sequence) > 9223372036854775807n
        )
          throw new Error();
        sequence = decoded.sequence;
      } catch {
        throw new DomainError('INVALID_TRANSACTION');
      }
    }
    const rows = await this.db.orm.em
      .fork()
      .execute<LedgerRow[]>(
        'SELECT * FROM wallet_ledger WHERE wallet_id=? AND sequence > ?::bigint ORDER BY sequence LIMIT ?',
        [id, sequence, limit + 1],
      );
    const items = rows.slice(0, limit);
    return {
      items: items.map((row) => ({
        id: row.id,
        walletId: row.wallet_id,
        transactionId: row.transaction_id,
        direction: row.direction,
        money: { amount: row.amount, currency: row.currency },
        balanceBefore: { amount: row.balance_before, currency: row.currency },
        balanceAfter: { amount: row.balance_after, currency: row.currency },
        createdAt: row.created_at,
      })),
      nextCursor:
        rows.length > limit
          ? Buffer.from(
              JSON.stringify({
                walletId: id,
                sequence: items.at(-1)!.sequence,
              }),
            ).toString('base64url')
          : null,
    };
  }
}

@Injectable()
export class SqlTransactionReadModel implements TransactionReadPort {
  constructor(private readonly db: Database) {}
  async getTransactionById(id: string) {
    const [row] = await this.db.orm.em
      .fork()
      .execute<TransactionRow[]>(
        'SELECT * FROM wager_transactions WHERE id=?',
        [id],
      );
    return this.transactionView(row);
  }
  async getTransactionByExternalId(provider: string, externalId: string) {
    const [row] = await this.db.orm.em
      .fork()
      .execute<TransactionRow[]>(
        'SELECT * FROM wager_transactions WHERE provider_id=? AND external_transaction_id=?',
        [provider, externalId],
      );
    return this.transactionView(row);
  }
  private transactionView(row: TransactionRow | undefined) {
    if (!row) throw new ResourceNotFoundError('Transaction');
    return {
      ...row.result,
      transactionId: row.id,
      providerId: row.provider_id,
      externalTransactionId: row.external_transaction_id,
      walletId: row.wallet_id,
      playerId: row.player_id,
      roundId: row.round_id,
      gameId: row.game_id,
      kind: row.kind,
      money: { amount: row.amount, currency: row.currency },
      status: row.status,
      failureCode: row.failure_code ?? undefined,
      referenceExternalTransactionId:
        row.reference_external_transaction_id ?? undefined,
      referenceTransactionId: row.reference_transaction_id ?? undefined,
      createdAt: row.created_at,
      processedAt: row.processed_at ?? undefined,
    };
  }
}
