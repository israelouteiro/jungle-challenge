import { Database } from '../../src/infrastructure/database/database';
import { MikroOrmFinancialUnitOfWork } from '../../src/infrastructure/database/financial-unit-of-work';
import {
  SqlWalletReadModel,
  SqlTransactionReadModel,
} from '../../src/infrastructure/database/read-models';
import { OpenWallet } from '../../src/application/use-cases/open-wallet';
import { ProcessWager } from '../../src/application/use-cases/process-wager';
import { ReconcileWallet } from '../../src/application/use-cases/queries';
/** Test composition root. Production injects the independent use cases directly. */
export function createServices(db: Database) {
  const uow = new MikroOrmFinancialUnitOfWork(db);
  const opening = new OpenWallet(uow);
  const processor = new ProcessWager(uow);
  const reader = new SqlWalletReadModel(db);
  const transactions = new SqlTransactionReadModel(db);
  const reconciliation = new ReconcileWallet(reader);
  return {
    openWallet: opening.execute.bind(opening),
    submit: processor.execute.bind(processor),
    retryPending: processor.retryPending.bind(processor),
    getWallet: reader.getWallet.bind(reader),
    transactionById: transactions.getTransactionById.bind(transactions),
    transactionByExternalId:
      transactions.getTransactionByExternalId.bind(transactions),
    reconcile: reconciliation.execute.bind(reconciliation),
    ledger: reader.ledger.bind(reader),
  };
}
