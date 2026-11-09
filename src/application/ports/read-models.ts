import { MoneyProps } from '../../domain/money';
import { LedgerDirection } from '../../domain/ledger-entry';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction';
export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}
export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  failureCode?: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  createdAt: Date;
  processedAt?: Date;
  balance?: MoneyProps;
  idempotentReplay?: boolean;
}
export interface LedgerEntryView {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: Date;
}
export interface LedgerPage {
  items: LedgerEntryView[];
  nextCursor: string | null;
}
export interface ReconciliationSnapshot {
  wallet: WalletView;
  calculatedBalance: MoneyProps;
  checkedEntries: number;
}
export abstract class WalletReadPort {
  abstract getWallet(id: string): Promise<WalletView>;
  abstract ledger(
    id: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<LedgerPage>;
  abstract reconciliationSnapshot(id: string): Promise<ReconciliationSnapshot>;
}
export abstract class TransactionReadPort {
  abstract getTransactionById(id: string): Promise<TransactionView>;
  abstract getTransactionByExternalId(
    providerId: string,
    externalId: string,
  ): Promise<TransactionView>;
}
