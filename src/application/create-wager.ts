import { randomUUID } from 'node:crypto';
import { WagerInput, text } from './contracts';
import { WagerTransaction } from '../domain/wager-transaction';
import { Money } from '../domain/money';
import { payloadHash } from '../domain/payload-hash';
export function createWager(input: WagerInput, key: string): WagerTransaction {
  text(key);
  return WagerTransaction.create({
    ...input,
    id: randomUUID(),
    idempotencyKey: key,
    payloadHash: payloadHash({ ...input }),
    money: Money.from(input.money),
    createdAt: new Date(),
  });
}
