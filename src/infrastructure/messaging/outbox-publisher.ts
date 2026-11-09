import {
  inSpan,
  remoteContext,
  SpanKind,
  traceHeaders,
} from '../../observability/tracing';
import process from 'node:process';
import { Injectable } from '@nestjs/common';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { Database } from '../database/database';
import { OutboxMessage } from '../../domain/delivery';
import { Sqs } from './sqs';
import { Telemetry } from '../../observability/telemetry';
import { MESSAGING_POLICY } from './messaging-policy';
@Injectable()
export class OutboxPublisher {
  constructor(
    private readonly db: Database,
    private readonly sqs: Sqs,
    private readonly telemetry: Telemetry,
  ) {}
  async publishOnce(): Promise<number> {
    return this.db.orm.em.fork().transactional(async (em) => {
      const rows = await em.execute<
        {
          id: string;
          aggregate_id: string;
          event_type: string;
          payload: Record<string, unknown>;
          attempts: number;
          occurred_at: Date;
        }[]
      >(
        `SELECT * FROM outbox WHERE published_at IS NULL AND next_attempt_at<=now() ORDER BY next_attempt_at,id LIMIT ? FOR UPDATE SKIP LOCKED`,
        [MESSAGING_POLICY.outboxBatchSize],
      );
      let published = 0;
      for (const row of rows) {
        const message = OutboxMessage.rehydrate({
          id: row.id,
          aggregateId: row.aggregate_id,
          eventType: row.event_type,
          payload: row.payload,
          attempts: row.attempts,
          occurredAt: row.occurred_at,
        });
        try {
          await inSpan(
            'outbox.publish',
            SpanKind.PRODUCER,
            { 'messaging.system': 'aws_sqs', 'messaging.message.id': row.id },
            () =>
              this.sqs.client.send(
                new SendMessageCommand({
                  QueueUrl: this.sqs.events,
                  MessageBody: JSON.stringify(row.payload),
                  MessageAttributes: Object.fromEntries(
                    Object.entries(traceHeaders()).map(([key, value]) => [
                      key,
                      { DataType: 'String', StringValue: value },
                    ]),
                  ),
                  MessageGroupId: row.aggregate_id,
                  MessageDeduplicationId: row.id,
                }),
              ),
            remoteContext(
              (row.payload.traceContext ?? {}) as Record<string, string>,
            ),
          );
        } catch {
          message.scheduleRetry(new Date());
          await em.execute(
            'UPDATE outbox SET attempts=?,next_attempt_at=? WHERE id=?',
            [message.attempts, message.nextAttemptAt, row.id],
          );
          this.telemetry.increment('retries_total');
          continue;
        }
        if (
          process.env.NODE_ENV === 'test' &&
          process.env.FAILPOINT === 'afterPublish'
        )
          process.kill(process.pid, 'SIGKILL');
        message.markPublished(new Date());
        await em.execute(
          'UPDATE outbox SET published_at=?,attempts=? WHERE id=?',
          [message.publishedAt, message.attempts, row.id],
        );
        this.telemetry.increment('outbox_published_total');
        published++;
      }
      const [lag] = await em.execute<{ lag: string }[]>(
        `SELECT COALESCE(EXTRACT(EPOCH FROM now()-min(occurred_at)),0)::text AS lag FROM outbox WHERE published_at IS NULL`,
      );
      this.telemetry.gauge('outbox_lag_seconds', Number(lag!.lag));
      return published;
    });
  }
}
