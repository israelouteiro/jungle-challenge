import { inSpan, SpanKind } from '../../observability/tracing';
import { Injectable } from '@nestjs/common';
import { Telemetry } from '../../observability/telemetry';
import { Database } from './database';
import {
  FinancialUnitOfWork,
  FinancialSession,
} from '../../application/ports/financial-unit-of-work';
import { SqlWalletRepository } from './repositories/wallet-repository';
import { SqlWagerRepository } from './repositories/wager-repository';
import { SqlLedgerRepository } from './repositories/ledger-repository';
import { SqlOutboxRepository } from './repositories/outbox-repository';
import { SqlInboxRepository } from './repositories/inbox-repository';

@Injectable()
export class MikroOrmFinancialUnitOfWork extends FinancialUnitOfWork {
  constructor(
    private readonly db: Database,
    private readonly telemetry: Telemetry = new Telemetry(),
  ) {
    super();
  }
  async run<T>(work: (session: FinancialSession) => Promise<T>): Promise<T> {
    try {
      return await inSpan(
        'financial.transaction',
        SpanKind.CLIENT,
        { 'db.system.name': 'postgresql' },
        () =>
          this.db.orm.em.fork().transactional((em) =>
            work({
              wallets: new SqlWalletRepository(em),
              transactions: new SqlWagerRepository(em),
              ledger: new SqlLedgerRepository(em),
              outbox: new SqlOutboxRepository(em),
              inbox: new SqlInboxRepository(em),
            }),
          ),
      );
    } catch (error) {
      this.telemetry.recordLockConflict(error);
      throw error;
    }
  }
}
