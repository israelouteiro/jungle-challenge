import { DomainInvariantError, DomainError, FailureCode } from './domain-error';
import { Money } from './money';
import { LedgerDirection } from './ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}
export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}
export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}
export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  direction?: LedgerDirection;
}

export class WagerTransaction {
  private constructor(private state: WagerTransactionState) {}
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (
      !Object.values(WagerTransactionKind).includes(props.kind) ||
      [
        props.id,
        props.providerId,
        props.externalTransactionId,
        props.idempotencyKey,
        props.walletId,
        props.playerId,
        props.roundId,
        props.gameId,
        props.payloadHash,
      ].some(
        (value) => typeof value !== 'string' || value.trim().length === 0,
      ) ||
      props.money.isNegative() ||
      (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive())
    ) {
      throw new DomainError('INVALID_TRANSACTION');
    }
    const tx = WagerTransaction.rehydrate({
      ...props,
      status: WagerTransactionStatus.Pending,
    });
    if (
      tx.requiresReference() &&
      !props.referenceExternalTransactionId?.trim()
    ) {
      throw new DomainError('INVALID_REFERENCE');
    }
    if (
      props.referenceExternalTransactionId === props.externalTransactionId ||
      ([WagerTransactionKind.Bet, WagerTransactionKind.Opening].includes(
        props.kind,
      ) &&
        props.referenceExternalTransactionId)
    ) {
      throw new DomainError('INVALID_REFERENCE');
    }
    return tx;
  }
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction({
      ...state,
      createdAt: new Date(state.createdAt),
      processedAt: state.processedAt && new Date(state.processedAt),
    });
  }
  get id(): string {
    return this.state.id;
  }
  get providerId(): string {
    return this.state.providerId;
  }
  get externalTransactionId(): string {
    return this.state.externalTransactionId;
  }
  get idempotencyKey(): string {
    return this.state.idempotencyKey;
  }
  get payloadHash(): string {
    return this.state.payloadHash;
  }
  get walletId(): string {
    return this.state.walletId;
  }
  get playerId(): string {
    return this.state.playerId;
  }
  get roundId(): string {
    return this.state.roundId;
  }
  get gameId(): string {
    return this.state.gameId;
  }
  get kind(): WagerTransactionKind {
    return this.state.kind;
  }
  get money(): Money {
    return this.state.money;
  }
  get referenceExternalTransactionId(): string | undefined {
    return this.state.referenceExternalTransactionId;
  }
  get status(): WagerTransactionStatus {
    return this.state.status;
  }
  get referenceTransactionId(): string | undefined {
    return this.state.referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this.state.failureCode;
  }
  get createdAt(): Date {
    return new Date(this.state.createdAt);
  }
  get processedAt(): Date | undefined {
    return this.state.processedAt && new Date(this.state.processedAt);
  }
  get direction(): LedgerDirection | undefined {
    return this.state.direction;
  }
  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    direction?: LedgerDirection,
  ): void {
    this.assertMutable();
    if (this.requiresReference() && !referenceTransactionId)
      throw new DomainError('INVALID_REFERENCE');
    if (
      (this.affectsBalance() && !direction) ||
      (!this.affectsBalance() && direction)
    ) {
      throw new DomainError('INVALID_TRANSACTION');
    }
    if (this.affectsBalance() && this.kind !== WagerTransactionKind.Rollback) {
      const expected =
        this.kind === WagerTransactionKind.Bet
          ? LedgerDirection.Debit
          : LedgerDirection.Credit;
      if (direction !== expected) throw new DomainError('INVALID_TRANSACTION');
    }
    this.state = {
      ...this.state,
      status: WagerTransactionStatus.Processed,
      referenceTransactionId,
      processedAt: new Date(at),
      direction,
    };
  }
  markPendingReference(): void {
    this.assertMutable();
    if (!this.referenceExternalTransactionId)
      throw new DomainError('INVALID_REFERENCE');
    this.state = {
      ...this.state,
      status: WagerTransactionStatus.PendingReference,
    };
  }
  reject(code: FailureCode): void {
    this.assertMutable();
    this.state = {
      ...this.state,
      status: WagerTransactionStatus.Rejected,
      failureCode: code,
    };
  }
  fail(code: FailureCode): void {
    this.assertMutable();
    this.state = {
      ...this.state,
      status: WagerTransactionStatus.Failed,
      failureCode: code,
    };
  }
  isTerminal(): boolean {
    return [
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed,
    ].includes(this.status);
  }
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }
  requiresReference(): boolean {
    return [
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ].includes(this.kind);
  }
  matchesPayload(hash: string): boolean {
    return this.payloadHash === hash;
  }
  validateReference(reference: WagerTransaction): void {
    if (
      this.referenceExternalTransactionId !== reference.externalTransactionId ||
      this.providerId !== reference.providerId ||
      this.walletId !== reference.walletId ||
      this.playerId !== reference.playerId ||
      this.roundId !== reference.roundId
    ) {
      throw new DomainError('INVALID_REFERENCE');
    }
    // Currency mismatch has its own stable failure code.
    const equalAmount = this.money.equals(reference.money);
    const allowed =
      this.kind === WagerTransactionKind.Rollback
        ? [
            WagerTransactionKind.Bet,
            WagerTransactionKind.Win,
            WagerTransactionKind.Refund,
          ]
        : [WagerTransactionKind.Bet];
    if (
      !allowed.includes(reference.kind) ||
      (this.requiresReference() && !equalAmount)
    ) {
      throw new DomainError('INVALID_REFERENCE');
    }
    if (reference.status !== WagerTransactionStatus.Processed)
      throw new DomainError('REFERENCE_NOT_PROCESSED');
  }
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (!this.affectsBalance()) throw new DomainError('INVALID_TRANSACTION');
    if (this.requiresReference()) {
      if (!reference) throw new DomainError('INVALID_REFERENCE');
      this.validateReference(reference);
    }
    if (this.kind === WagerTransactionKind.Rollback) {
      if (!reference?.direction) throw new DomainError('INVALID_REFERENCE');
      return reference.direction === LedgerDirection.Debit
        ? LedgerDirection.Credit
        : LedgerDirection.Debit;
    }
    return this.kind === WagerTransactionKind.Bet
      ? LedgerDirection.Debit
      : LedgerDirection.Credit;
  }
  private assertMutable(): void {
    if (this.isTerminal())
      throw new DomainInvariantError('INVALID_TRANSACTION_STATE');
  }
}
