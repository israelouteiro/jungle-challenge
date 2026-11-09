import { EntityManager } from '@mikro-orm/postgresql';
import { InboxRepository } from '../../../application/ports/financial-unit-of-work';
import { InboxMessage } from '../../../domain/delivery';
import { DomainError } from '../../../domain/domain-error';

export class SqlInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}
  async receive(message: InboxMessage): Promise<void> {
    await this.em.execute(
      'INSERT INTO inbox(consumer_name,message_id,payload_hash) VALUES(?,?,?) ON CONFLICT DO NOTHING',
      [message.consumerName, message.messageId, message.payloadHash],
    );
    const [stored] = await this.em.execute<{ payload_hash: string }[]>(
      'SELECT payload_hash FROM inbox WHERE consumer_name=? AND message_id=? FOR UPDATE',
      [message.consumerName, message.messageId],
    );
    if (stored?.payload_hash !== message.payloadHash)
      throw new DomainError('IDEMPOTENCY_CONFLICT');
  }
  async complete(consumerName: string, messageId: string): Promise<void> {
    await this.em.execute(
      'UPDATE inbox SET processed_at=COALESCE(processed_at,now()) WHERE consumer_name=? AND message_id=?',
      [consumerName, messageId],
    );
  }
}
