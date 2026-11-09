import process from 'node:process';
import { connectDatabase } from './database';

async function main(): Promise<void> {
  const orm = await connectDatabase();
  try {
    if (process.argv[2] === 'down') await orm.migrator.down();
    else await orm.migrator.up();
  } finally {
    await orm.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
