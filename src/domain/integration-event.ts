import { MoneyProps } from './money';
import { LedgerDirection } from './ledger-entry';
export interface EventContext {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  readonly version = 1;
  private readonly context: EventContext;
  private readonly eventData: Readonly<T>;
  protected constructor(context: EventContext, data: T) {
    this.context = { ...context, occurredAt: new Date(context.occurredAt) };
    this.eventData = structuredClone(data);
  }
  get eventId(): string {
    return this.context.eventId;
  }
  get aggregateId(): string {
    return this.context.aggregateId;
  }
  get correlationId(): string {
    return this.context.correlationId;
  }
  get causationId(): string | undefined {
    return this.context.causationId;
  }
  get occurredAt(): Date {
    return new Date(this.context.occurredAt);
  }
  get data(): Readonly<T> {
    return structuredClone(this.eventData);
  }
  toJSON() {
    return {
      ...this.context,
      occurredAt: this.context.occurredAt.toISOString(),
      eventType: this.eventType,
      version: this.version,
      data: this.data,
    };
  }
}
export interface TransactionEventData {
  transactionId: string;
  walletId: string;
  providerId: string;
  status: string;
  failureCode?: string;
}
export class WagerTransactionProcessed extends IntegrationEvent<TransactionEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  static create(ctx: EventContext, data: TransactionEventData) {
    return new this(ctx, data);
  }
}
export class WagerTransactionRejected extends IntegrationEvent<TransactionEventData> {
  readonly eventType = 'WagerTransactionRejected';
  static create(ctx: EventContext, data: TransactionEventData) {
    return new this(ctx, data);
  }
}
export class WagerTransactionPendingReference extends IntegrationEvent<TransactionEventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  static create(ctx: EventContext, data: TransactionEventData) {
    return new this(ctx, data);
  }
}
export interface BalanceEventData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}
export class WalletBalanceChanged extends IntegrationEvent<BalanceEventData> {
  readonly eventType = 'WalletBalanceChanged';
  static create(ctx: EventContext, data: BalanceEventData) {
    return new this(ctx, data);
  }
}

export class WagerTransactionFailed extends IntegrationEvent<TransactionEventData> {
  readonly eventType = 'WagerTransactionFailed';
  static create(ctx: EventContext, data: TransactionEventData) {
    return new this(ctx, data);
  }
}
