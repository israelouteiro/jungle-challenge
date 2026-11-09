import { FailWager } from '../../src/application/use-cases/fail-wager';
import process from 'node:process';
import { Database } from '../../src/infrastructure/database/database';
import { ProcessWager } from '../../src/application/use-cases/process-wager';
import { MikroOrmFinancialUnitOfWork } from '../../src/infrastructure/database/financial-unit-of-work';
import { Sqs } from '../../src/infrastructure/messaging/sqs';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
import { WagerConsumer } from '../../src/infrastructure/messaging/wager-consumer';
import { Telemetry } from '../../src/observability/telemetry';
const db = new Database();
await db.onModuleInit();
const sqs = new Sqs();
const telemetry = new Telemetry();
const publisher = new OutboxPublisher(db, sqs, telemetry);
const consumer = new WagerConsumer(
  new ProcessWager(new MikroOrmFinancialUnitOfWork(db)),
  new FailWager(new MikroOrmFinancialUnitOfWork(db)),
  sqs,
  telemetry,
);
try {
  if (process.argv[2] === 'reference')
    await new ProcessWager(new MikroOrmFinancialUnitOfWork(db)).retryPending(
      process.argv[3]!,
    );
  else if (process.argv[2] === 'publish') await publisher.publishOnce();
  else await consumer.consumeOnce();
} finally {
  sqs.client.destroy();
  await db.onApplicationShutdown();
}
