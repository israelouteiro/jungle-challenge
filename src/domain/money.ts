import Decimal from 'decimal.js';
import { DomainError } from './domain-error';

export interface MoneyProps {
  amount: string;
  currency: string;
}

// Isolated configuration: another library cannot change our arithmetic precision.
const ExactDecimal = Decimal.clone({ precision: 48 });
const currencies = new Set(Intl.supportedValuesOf('currency'));
const MAX = '999999999999999999.99';

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    return Money.parse(props, false);
  }

  /** Only persisted/internal values may carry a sign. No transition is replayed. */
  static rehydrate(props: MoneyProps): Money {
    return Money.parse(props, true);
  }

  private static parse(props: MoneyProps, signed: boolean): Money {
    if (
      !props ||
      typeof props.amount !== 'string' ||
      !(signed ? /^-?\d+(?:\.\d{1,2})?$/ : /^\d+\.\d{2}$/).test(props.amount) ||
      typeof props.currency !== 'string' ||
      !currencies.has(props.currency)
    ) {
      throw new DomainError('INVALID_MONEY');
    }
    return Money.exact(new ExactDecimal(props.amount), props.currency);
  }

  private static exact(value: Decimal, currency: string): Money {
    if (
      !value.isFinite() ||
      value.abs().greaterThan(MAX) ||
      value.decimalPlaces() > 2
    ) {
      throw new DomainError('INVALID_MONEY');
    }
    return new Money(value, currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }
  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.exact(this.value.plus(other.value), this.currency);
  }
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.exact(this.value.minus(other.value), this.currency);
  }
  negate(): Money {
    return Money.exact(this.value.negated(), this.currency);
  }
  isZero(): boolean {
    return this.value.isZero();
  }
  isPositive(): boolean {
    return this.value.greaterThan(0);
  }
  isNegative(): boolean {
    return this.value.lessThan(0);
  }
  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }
  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }
  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }
  toString(): string {
    return this.value.toFixed(2);
  }
  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency)
      throw new DomainError('CURRENCY_MISMATCH');
  }
}
