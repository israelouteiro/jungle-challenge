import { EntityManager } from '@mikro-orm/postgresql';
import { OutboxRepository } from '../../../application/ports/financial-unit-of-work';
import { IntegrationEvent } from '../../../domain/integration-event';
import { OutboxMessage } from '../../../domain/delivery';
import { traceHeaders } from '../../../observability/tracing';

export class SqlOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}
  async enqueue(event: IntegrationEvent<unknown>): Promise<void> {
    const message = OutboxMessage.enqueue(event);
    await this.em.execute(
      'INSERT INTO outbox(id,aggregate_id,event_type,payload) VALUES(?,?,?,?::jsonb)',
      [
        message.id,
        message.aggregateId,
        message.eventType,
        JSON.stringify({ ...message.payload, traceContext: traceHeaders() }),
      ],
    );
  }
}
