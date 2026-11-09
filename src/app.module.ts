import { TracingLifecycle } from './observability/tracing-lifecycle';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { FinancialMetrics } from './infrastructure/database/financial-metrics';
import { Database } from './infrastructure/database/database';
import { MikroOrmFinancialUnitOfWork } from './infrastructure/database/financial-unit-of-work';
import {
  SqlWalletReadModel,
  SqlTransactionReadModel,
} from './infrastructure/database/read-models';
import { SqlPendingReferenceReader } from './infrastructure/database/pending-reference-reader';
import { FinancialUnitOfWork } from './application/ports/financial-unit-of-work';
import {
  WalletReadPort,
  TransactionReadPort,
} from './application/ports/read-models';
import { PendingReferenceReader } from './application/ports/pending-reference-reader';
import { OpenWallet } from './application/use-cases/open-wallet';
import { FailWager } from './application/use-cases/fail-wager';
import { ProcessWager } from './application/use-cases/process-wager';
import {
  WalletQueries,
  TransactionQueries,
  ReconcileWallet,
} from './application/use-cases/queries';
import { WalletController } from './http/wallet.controller';
import { WageringController } from './http/wagering.controller';
import { ApiExceptionFilter } from './http/api-exception.filter';
import { HealthController } from './http/health.controller';
import { ProviderIdentityGuard } from './http/provider-identity.guard';
import { Sqs } from './infrastructure/messaging/sqs';
import { DlqAuditor } from './infrastructure/messaging/dlq-auditor';
import { Workers } from './infrastructure/messaging/workers';
import { WagerConsumer } from './infrastructure/messaging/wager-consumer';
import { OutboxPublisher } from './infrastructure/messaging/outbox-publisher';
import { PendingReferenceWorker } from './infrastructure/messaging/pending-reference-worker';
import { Telemetry } from './observability/telemetry';
@Module({
  controllers: [WalletController, WageringController, HealthController],
  providers: [
    TracingLifecycle,
    Database,
    FinancialMetrics,
    MikroOrmFinancialUnitOfWork,
    SqlWalletReadModel,
    SqlTransactionReadModel,
    SqlPendingReferenceReader,
    { provide: FinancialUnitOfWork, useExisting: MikroOrmFinancialUnitOfWork },
    { provide: WalletReadPort, useExisting: SqlWalletReadModel },
    { provide: TransactionReadPort, useExisting: SqlTransactionReadModel },
    { provide: PendingReferenceReader, useExisting: SqlPendingReferenceReader },
    {
      provide: OpenWallet,
      useFactory: (uow: FinancialUnitOfWork) => new OpenWallet(uow),
      inject: [FinancialUnitOfWork],
    },
    {
      provide: ProcessWager,
      useFactory: (uow: FinancialUnitOfWork) => new ProcessWager(uow),
      inject: [FinancialUnitOfWork],
    },
    {
      provide: WalletQueries,
      useFactory: (reader: WalletReadPort) => new WalletQueries(reader),
      inject: [WalletReadPort],
    },
    {
      provide: TransactionQueries,
      useFactory: (reader: TransactionReadPort) =>
        new TransactionQueries(reader),
      inject: [TransactionReadPort],
    },
    {
      provide: ReconcileWallet,
      useFactory: (reader: WalletReadPort) => new ReconcileWallet(reader),
      inject: [WalletReadPort],
    },
    {
      provide: FailWager,
      useFactory: (uow: FinancialUnitOfWork) => new FailWager(uow),
      inject: [FinancialUnitOfWork],
    },
    { provide: Sqs, useFactory: () => new Sqs() },
    Workers,
    DlqAuditor,
    {
      provide: WagerConsumer,
      useFactory: (
        processor: ProcessWager,
        failure: FailWager,
        sqs: Sqs,
        telemetry: Telemetry,
      ) => new WagerConsumer(processor, failure, sqs, telemetry),
      inject: [ProcessWager, FailWager, Sqs, Telemetry],
    },
    OutboxPublisher,
    PendingReferenceWorker,
    Telemetry,
    ProviderIdentityGuard,
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}
