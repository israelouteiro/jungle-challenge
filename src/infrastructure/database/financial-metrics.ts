import { Injectable } from '@nestjs/common';
import { Database } from './database';
import { WagerTransactionStatus as Status } from '../../domain/wager-transaction';
@Injectable()
export class FinancialMetrics {
  constructor(private readonly db: Database) {}
  async collect(): Promise<
    Record<Status, { current: number; transitions: number }>
  > {
    const rows = await this.db.orm.em.fork().execute<
      { category: 'current' | 'transitions'; status: Status; count: string }[]
    >(`
      SELECT 'current' AS category,status,count(*)::text AS count FROM wager_transactions GROUP BY status
      UNION ALL
      SELECT 'transitions',payload->'data'->>'status',count(*)::text FROM outbox
      WHERE event_type IN ('WagerTransactionProcessed','WagerTransactionRejected','WagerTransactionPendingReference','WagerTransactionFailed')
      GROUP BY payload->'data'->>'status'`);
    const counts = Object.fromEntries(
      Object.values(Status).map((status) => [
        status,
        { current: 0, transitions: 0 },
      ]),
    ) as Record<Status, { current: number; transitions: number }>;
    for (const row of rows)
      if (counts[row.status])
        counts[row.status][row.category] = Number(row.count);
    return counts;
  }
  async outboxSnapshot(): Promise<{
    pending: number;
    oldestPendingAgeSeconds: number;
  }> {
    const [row] = await this.db.orm.em.fork().execute<
      { pending: string; age: string }[]
    >(`
      SELECT count(*)::text AS pending,
        COALESCE(GREATEST(EXTRACT(EPOCH FROM clock_timestamp()-min(occurred_at)),0),0)::text AS age
      FROM outbox WHERE published_at IS NULL`);
    return {
      pending: Number(row!.pending),
      oldestPendingAgeSeconds: Number(row!.age),
    };
  }
  async render(): Promise<string> {
    const [counts, outbox] = await Promise.all([
      this.collect(),
      this.outboxSnapshot(),
    ]);
    return (
      `# TYPE jungle_outbox_pending gauge\njungle_outbox_pending ${outbox.pending}\n# TYPE jungle_outbox_oldest_pending_age_seconds gauge\njungle_outbox_oldest_pending_age_seconds ${outbox.oldestPendingAgeSeconds}\n` +
      '# TYPE jungle_wager_transactions gauge\n' +
      Object.entries(counts)
        .map(
          ([status, value]) =>
            `jungle_wager_transactions{status="${status}"} ${value.current}`,
        )
        .join('\n') +
      '\n# TYPE jungle_transaction_transitions_total counter\n' +
      Object.entries(counts)
        .map(
          ([status, value]) =>
            `jungle_transaction_transitions_total{status="${status}"} ${value.transitions}`,
        )
        .join('\n') +
      '\n'
    );
  }
}
