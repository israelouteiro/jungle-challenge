import { DomainError } from '../domain/domain-error';
import { Money, MoneyProps } from '../domain/money';
import { WagerTransactionKind } from '../domain/wager-transaction';
export interface WagerInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DomainError('INVALID_TRANSACTION');
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256)
    throw new DomainError('INVALID_TRANSACTION');
  return value;
}
export function uuid(value: unknown): string {
  const id = text(value);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    throw new DomainError('INVALID_TRANSACTION');
  return id.toLowerCase();
}
export function moneyInput(value: unknown): MoneyProps {
  const data = object(value);
  return Money.from({
    amount: data.amount as string,
    currency: data.currency as string,
  }).toJSON();
}
export function wagerInput(value: unknown): WagerInput {
  const data = object(value);
  const kind = text(data.kind) as WagerTransactionKind;
  if (
    !Object.values(WagerTransactionKind).includes(kind) ||
    kind === WagerTransactionKind.Opening
  )
    throw new DomainError('INVALID_TRANSACTION');
  const input: WagerInput = {
    providerId: text(data.providerId),
    externalTransactionId: text(data.externalTransactionId),
    playerId: uuid(data.playerId),
    walletId: uuid(data.walletId),
    roundId: text(data.roundId),
    gameId: text(data.gameId),
    kind,
    money: moneyInput(data.money),
  };
  if (data.referenceExternalTransactionId !== undefined)
    input.referenceExternalTransactionId = text(
      data.referenceExternalTransactionId,
    );
  return input;
}
