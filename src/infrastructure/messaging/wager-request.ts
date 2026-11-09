import { object, text, wagerInput } from '../../application/contracts';
import { payloadHash } from '../../domain/payload-hash';
import { DomainError } from '../../domain/domain-error';
export function readWagerRequest(body: string) {
  const envelope = object(JSON.parse(body));
  const messageId = text(envelope.messageId);
  if (
    envelope.type !== 'WagerTransactionRequested' ||
    typeof envelope.occurredAt !== 'string' ||
    !Number.isFinite(Date.parse(envelope.occurredAt))
  ) {
    throw new DomainError('INVALID_TRANSACTION');
  }
  const data = object(envelope.data);
  const input = wagerInput(data);
  const key = text(data.idempotencyKey);
  return {
    input,
    key,
    messageId,
    inbox: {
      consumerName: 'wagering-v1',
      messageId,
      hash: payloadHash({ ...input, idempotencyKey: key }),
    },
  };
}
