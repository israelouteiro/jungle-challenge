import { DomainError } from './domain-error';
import { Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementContext {
  entryId: string;
  transactionId: string;
  at: Date;
  reversal?: boolean;
}

export class Wallet {
  private constructor(private state: WalletState) {}
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    at?: Date;
  }): Wallet {
    if (props.initialBalance.isNegative())
      throw new DomainError('INVALID_MONEY');
    const at = props.at ?? new Date();
    return Wallet.rehydrate({
      ...props,
      balance: props.initialBalance,
      currency: props.initialBalance.currency,
      version: 1,
      createdAt: at,
      updatedAt: at,
    });
  }
  static rehydrate(state: WalletState): Wallet {
    return new Wallet({
      ...state,
      createdAt: new Date(state.createdAt),
      updatedAt: new Date(state.updatedAt),
    });
  }
  get id(): string {
    return this.state.id;
  }
  get playerId(): string {
    return this.state.playerId;
  }
  get currency(): string {
    return this.state.currency;
  }
  get balance(): Money {
    return this.state.balance;
  }
  get version(): number {
    return this.state.version;
  }
  get createdAt(): Date {
    return new Date(this.state.createdAt);
  }
  get updatedAt(): Date {
    return new Date(this.state.updatedAt);
  }
  credit(money: Money, ctx: MovementContext): WalletLedgerEntry {
    return this.move(money, LedgerDirection.Credit, ctx);
  }
  debit(money: Money, ctx: MovementContext): WalletLedgerEntry {
    return this.move(money, LedgerDirection.Debit, ctx);
  }
  private move(
    money: Money,
    direction: LedgerDirection,
    ctx: MovementContext,
  ): WalletLedgerEntry {
    if (money.currency !== this.currency)
      throw new DomainError('CURRENCY_MISMATCH');
    if (!money.isPositive()) throw new DomainError('INVALID_MONEY');
    if (direction === LedgerDirection.Debit && this.balance.isLessThan(money)) {
      throw new DomainError(
        ctx.reversal ? 'REVERSAL_INSUFFICIENT_FUNDS' : 'INSUFFICIENT_FUNDS',
      );
    }
    const after =
      direction === LedgerDirection.Credit
        ? this.balance.add(money)
        : this.balance.subtract(money);
    const entry = WalletLedgerEntry.create({
      id: ctx.entryId,
      walletId: this.id,
      transactionId: ctx.transactionId,
      money,
      direction,
      balanceBefore: this.balance,
      balanceAfter: after,
      createdAt: ctx.at,
    });
    this.state = {
      ...this.state,
      balance: after,
      version: this.version + 1,
      updatedAt: new Date(ctx.at),
    };
    return entry;
  }
}
