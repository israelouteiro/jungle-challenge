import { randomUUID } from 'node:crypto';
import { LoadClient } from '../client';
import { assert } from '../assert';
import { ScenarioRunner } from '../scenario';
import { pool } from '../pool';

export async function independentWallets(
  client: LoadClient,
  runner: ScenarioRunner,
  requests: number,
  concurrency: number,
) {
  const independent = await pool(
    Math.min(concurrency, requests),
    concurrency,
    () => client.wallet(),
  );
  const counts = independent.map(() => 0);
  await runner.run('independentWallets', async (index, lane) => {
    const result = await client.call(
      '/wagering/transactions',
      client.wager(independent[lane]!),
      randomUUID(),
      index,
    );
    assert(
      (result.data as { status: string }).status === 'PROCESSED',
      'Unexpected result',
    );
    counts[lane]!++;
    return result.status;
  });
  for (let i = 0; i < independent.length; i++)
    await client.check(independent[i]!, BigInt(counts[i]!), counts[i]!);
}
