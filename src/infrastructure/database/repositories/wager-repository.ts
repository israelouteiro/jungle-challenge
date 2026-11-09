import { EntityManager } from '@mikro-orm/postgresql';
import {
  WagerRepository,
  StoredTransaction,
  TransactionResult,
} from '../../../application/ports/financial-unit-of-work';
import { WagerTransaction } from '../../../domain/wager-transaction';
import { TransactionRow, transactionFrom } from '../transaction-mapper';

export class SqlWagerRepository implements WagerRepository {
  constructor(private readonly em: EntityManager) {}
  async reserve(tx: WagerTransaction): Promise<boolean> {
    const inserted = await this.em.execute<{ id: string }[]>(
      `INSERT INTO wager_transactions
      (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,reference_external_transaction_id,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING') ON CONFLICT DO NOTHING RETURNING id`,
      [
        tx.id,
        tx.providerId,
        tx.externalTransactionId,
        tx.idempotencyKey,
        tx.payloadHash,
        tx.walletId,
        tx.playerId,
        tx.roundId,
        tx.gameId,
        tx.kind,
        tx.money.toString(),
        tx.money.currency,
        tx.referenceExternalTransactionId ?? null,
      ],
    );
    return inserted.length > 0;
  }
  async findConflicts(tx: WagerTransaction): Promise<StoredTransaction[]> {
    const rows = await this.em.execute<TransactionRow[]>(
      `SELECT * FROM wager_transactions
      WHERE idempotency_key=? OR (provider_id=? AND external_transaction_id=?) ORDER BY id FOR UPDATE`,
      [tx.idempotencyKey, tx.providerId, tx.externalTransactionId],
    );
    return rows.map((row) => ({
      transaction: transactionFrom(row),
      result: row.result,
      attempts: row.attempts,
    }));
  }
  async findReference(
    providerId: string,
    externalId: string,
  ): Promise<WagerTransaction | undefined> {
    const [row] = await this.em.execute<TransactionRow[]>(
      'SELECT * FROM wager_transactions WHERE provider_id=? AND external_transaction_id=?',
      [providerId, externalId],
    );
    return row && transactionFrom(row);
  }
  async lockDue(id: string): Promise<StoredTransaction | undefined> {
    const [row] = await this.em.execute<TransactionRow[]>(
      `SELECT * FROM wager_transactions WHERE id=? AND status='PENDING_REFERENCE' AND next_attempt_at<=clock_timestamp() FOR UPDATE`,
      [id],
    );
    return (
      row && {
        transaction: transactionFrom(row),
        result: row.result,
        attempts: row.attempts,
      }
    );
  }
  async hasReversal(referenceId: string, kind: string): Promise<boolean> {
    return (
      (
        await this.em.execute(
          `SELECT id FROM wager_transactions WHERE reference_transaction_id=? AND kind=? AND status='PROCESSED'`,
          [referenceId, kind],
        )
      ).length > 0
    );
  }
  async save(
    tx: WagerTransaction,
    result: TransactionResult,
    attempts: number,
    nextAttemptAt: Date,
  ): Promise<void> {
    await this.em.execute(
      `UPDATE wager_transactions SET status=?,failure_code=?,reference_transaction_id=?,direction=?,processed_at=?,result=?::jsonb,
      attempts=?,next_attempt_at=? WHERE id=?`,
      [
        tx.status,
        tx.failureCode ?? null,
        tx.referenceTransactionId ?? null,
        tx.direction ?? null,
        tx.processedAt ?? null,
        JSON.stringify(result),
        attempts,
        nextAttemptAt,
        tx.id,
      ],
    );
  }
}
