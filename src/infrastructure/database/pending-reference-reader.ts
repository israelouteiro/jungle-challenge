import { Injectable } from '@nestjs/common';
import { Database } from './database';
import { PendingReferenceReader } from '../../application/ports/pending-reference-reader';
@Injectable()
export class SqlPendingReferenceReader extends PendingReferenceReader {
  constructor(private readonly db: Database) {
    super();
  }
  async dueIds(limit: number): Promise<string[]> {
    const rows = await this.db.orm.em
      .fork()
      .execute<{ id: string }[]>(
        `SELECT id FROM wager_transactions WHERE status='PENDING_REFERENCE' AND next_attempt_at<=now() ORDER BY next_attempt_at,id LIMIT ?`,
        [limit],
      );
    return rows.map((row) => row.id);
  }
}
