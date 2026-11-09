import { WalletReadPort, TransactionReadPort } from '../ports/read-models';
import { Money } from '../../domain/money';
export class WalletQueries {
  constructor(private readonly reader: WalletReadPort) {}
  get(id: string) {
    return this.reader.getWallet(id);
  }
  ledger(id: string, cursor: string | undefined, limit: number) {
    return this.reader.ledger(id, cursor, limit);
  }
}
export class TransactionQueries {
  constructor(private readonly reader: TransactionReadPort) {}
  byId(id: string) {
    return this.reader.getTransactionById(id);
  }
  byExternalId(providerId: string, externalId: string) {
    return this.reader.getTransactionByExternalId(providerId, externalId);
  }
}
export class ReconcileWallet {
  constructor(private readonly reader: WalletReadPort) {}
  async execute(id: string) {
    const { wallet, calculatedBalance, checkedEntries } =
      await this.reader.reconciliationSnapshot(id);
    const stored = Money.rehydrate(wallet.balance);
    const calculated = Money.rehydrate(calculatedBalance);
    return {
      walletId: id,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: stored.subtract(calculated).toJSON(),
      consistent: stored.equals(calculated),
      checkedEntries,
    };
  }
}
