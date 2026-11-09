import process from 'node:process';
import { mkdir } from 'node:fs/promises';
import {
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { WalletSchema } from './wallet-record';
import { Migration202611080002 } from './migrations/Migration202611080002';
import { Migration202611080001 } from './migrations/Migration202611080001';

export async function connectDatabase(
  clientUrl = process.env.DATABASE_URL ??
    'postgresql://jungle:jungle@localhost:5432/jungle',
) {
  const lockTimeout = Number(process.env.PG_LOCK_TIMEOUT_MS ?? '5000');
  if (!Number.isInteger(lockTimeout) || lockTimeout < 1 || lockTimeout > 60000)
    throw new Error('Invalid PG_LOCK_TIMEOUT_MS');
  await mkdir('.snapshots', { recursive: true });
  const orm = new MikroORM({
    entities: [WalletSchema],
    clientUrl,
    extensions: [Migrator],
    migrations: {
      path: '.snapshots',
      pathTs: '.snapshots',
      migrationsList: [Migration202611080001, Migration202611080002],
      transactional: true,
      allOrNothing: true,
    },
    pool: { min: 0, max: 10 },
    driverOptions: {
      application_name: process.env.INSTANCE_ID ?? 'jungle-wagering',
      statement_timeout: 10000,
      lock_timeout: lockTimeout,
      connectionTimeoutMillis: 3000,
    },
  });
  await orm.connect();
  return orm;
}
export type DatabaseOrm = Awaited<ReturnType<typeof connectDatabase>>;
@Injectable()
export class Database implements OnModuleInit, OnApplicationShutdown {
  orm!: DatabaseOrm;
  async onModuleInit(): Promise<void> {
    this.orm = await connectDatabase();
  }
  async onApplicationShutdown(): Promise<void> {
    await this.orm?.close();
  }
}
