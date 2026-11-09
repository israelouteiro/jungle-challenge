import process from 'node:process';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { WalletSchema } from '../../src/infrastructure/database/wallet-record';
import { connectDatabase } from '../../src/infrastructure/database/database';
import { Migration202611080001 } from '../../src/infrastructure/database/migrations/Migration202611080001';
import { Migration202611080002 } from '../../src/infrastructure/database/migrations/Migration202611080002';

test('all migrations up/down/up in an isolated database', async () => {
  const admin = await connectDatabase();
  const name = `migration_test_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(
    process.env.DATABASE_URL ??
      'postgresql://jungle:jungle@localhost:5432/jungle',
  );
  url.pathname = `/${name}`;
  let isolated: MikroORM | undefined;
  try {
    await admin.em.fork().execute(`CREATE DATABASE "${name}"`);
    isolated = new MikroORM({
      entities: [WalletSchema],
      clientUrl: url.toString(),
      extensions: [Migrator],
      migrations: {
        path: '.snapshots',
        pathTs: '.snapshots',
        migrationsList: [Migration202611080001, Migration202611080002],
      },
    });
    await isolated.connect();
    await isolated.migrator.up();
    expect(
      await isolated.em.fork().execute('SELECT * FROM mikro_orm_migrations'),
    ).toHaveLength(2);
    await isolated.migrator.down({ to: 0 });
    expect(
      await isolated.em.fork().execute('SELECT * FROM mikro_orm_migrations'),
    ).toHaveLength(0);
    await isolated.migrator.up();
    expect(
      await isolated.em.fork().execute('SELECT * FROM mikro_orm_migrations'),
    ).toHaveLength(2);
  } finally {
    await isolated?.close();
    await admin.em
      .fork()
      .execute(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.close();
  }
});
