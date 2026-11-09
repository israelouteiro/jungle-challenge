import { Wallet } from '../../domain/wallet';
import { WagerTransaction } from '../../domain/wager-transaction';
import { WalletLedgerEntry } from '../../domain/ledger-entry';
import { IntegrationEvent } from '../../domain/integration-event';
import { InboxMessage } from '../../domain/delivery';
import { MoneyProps } from '../../domain/money';
import { WagerTransactionStatus } from '../../domain/wager-transaction';
export interface TransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: string;
  idempotentReplay: boolean;
}
export interface StoredTransaction {
  transaction: WagerTransaction;
  result: TransactionResult | null;
  attempts: number;
}
export interface WalletRepository {
  exists(id: string): Promise<boolean>;
  create(wallet: Wallet): Promise<void>;
  lock(id: string): Promise<Wallet | undefined>;
  save(wallet: Wallet): Promise<void>;
}
export interface WagerRepository {
  reserve(transaction: WagerTransaction): Promise<boolean>;
  findConflicts(transaction: WagerTransaction): Promise<StoredTransaction[]>;
  findReference(
    providerId: string,
    externalId: string,
  ): Promise<WagerTransaction | undefined>;
  lockDue(id: string): Promise<StoredTransaction | undefined>;
  hasReversal(referenceId: string, kind: string): Promise<boolean>;
  save(
    transaction: WagerTransaction,
    result: TransactionResult,
    attempts: number,
    nextAttemptAt: Date,
  ): Promise<void>;
}
export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
}
export interface OutboxRepository {
  enqueue(event: IntegrationEvent<unknown>): Promise<void>;
}
export interface InboxRepository {
  receive(message: InboxMessage): Promise<void>;
  complete(consumerName: string, messageId: string): Promise<void>;
}
/** All repositories in the callback share ONE SQL transaction and lock lifetime. */
export interface FinancialSession {
  wallets: WalletRepository;
  transactions: WagerRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
}
export abstract class FinancialUnitOfWork {
  abstract run<T>(work: (session: FinancialSession) => Promise<T>): Promise<T>;
}
