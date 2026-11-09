import { DomainInvariantError, DomainError } from './domain-error';
import { IntegrationEvent } from './integration-event';

export interface InboxState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}
export class InboxMessage {
  private constructor(private state: InboxState) {}
  static receive(props: Omit<InboxState, 'processedAt'>): InboxMessage {
    if (
      !props.messageId ||
      !props.consumerName ||
      !/^[a-f0-9]{64}$/.test(props.payloadHash)
    )
      throw new DomainError('INVALID_TRANSACTION');
    return InboxMessage.rehydrate(props);
  }
  static rehydrate(state: InboxState): InboxMessage {
    return new InboxMessage({
      ...state,
      receivedAt: new Date(state.receivedAt),
      processedAt: state.processedAt && new Date(state.processedAt),
    });
  }
  get messageId(): string {
    return this.state.messageId;
  }
  get consumerName(): string {
    return this.state.consumerName;
  }
  get payloadHash(): string {
    return this.state.payloadHash;
  }
  get receivedAt(): Date {
    return new Date(this.state.receivedAt);
  }
  get processedAt(): Date | undefined {
    return this.state.processedAt && new Date(this.state.processedAt);
  }
  isProcessed(): boolean {
    return this.state.processedAt !== undefined;
  }
  markProcessed(at: Date): void {
    if (this.isProcessed())
      throw new DomainInvariantError('INVALID_TRANSACTION_STATE');
    this.state = { ...this.state, processedAt: new Date(at) };
  }
}
export interface OutboxState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}
export class OutboxMessage {
  private constructor(private state: OutboxState) {}
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = event.toJSON();
    return OutboxMessage.rehydrate({
      id: payload.eventId,
      aggregateId: payload.aggregateId,
      eventType: payload.eventType,
      payload,
      occurredAt: new Date(payload.occurredAt),
      attempts: 0,
    });
  }
  static rehydrate(state: OutboxState): OutboxMessage {
    return new OutboxMessage({
      ...state,
      payload: structuredClone(state.payload),
      occurredAt: new Date(state.occurredAt),
      nextAttemptAt: state.nextAttemptAt && new Date(state.nextAttemptAt),
      publishedAt: state.publishedAt && new Date(state.publishedAt),
    });
  }
  get id(): string {
    return this.state.id;
  }
  get aggregateId(): string {
    return this.state.aggregateId;
  }
  get eventType(): string {
    return this.state.eventType;
  }
  get payload(): Readonly<Record<string, unknown>> {
    return structuredClone(this.state.payload);
  }
  get occurredAt(): Date {
    return new Date(this.state.occurredAt);
  }
  get attempts(): number {
    return this.state.attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this.state.nextAttemptAt && new Date(this.state.nextAttemptAt);
  }
  get publishedAt(): Date | undefined {
    return this.state.publishedAt && new Date(this.state.publishedAt);
  }
  isPending(): boolean {
    return this.state.publishedAt === undefined;
  }
  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (!this.state.nextAttemptAt || this.state.nextAttemptAt <= now)
    );
  }
  markPublished(at: Date): void {
    this.assertPending();
    this.state = {
      ...this.state,
      attempts: this.attempts + 1,
      publishedAt: new Date(at),
    };
  }
  scheduleRetry(now: Date): void {
    this.assertPending();
    const attempts = this.attempts + 1;
    this.state = {
      ...this.state,
      attempts,
      nextAttemptAt: new Date(
        now.getTime() + Math.min(3600, 2 ** Math.min(attempts, 12)) * 1000,
      ),
    };
  }
  private assertPending(): void {
    if (!this.isPending())
      throw new DomainInvariantError('INVALID_TRANSACTION_STATE');
  }
}
