import { randomUUID } from 'node:crypto';
import { LoadClient } from '../client';
import { assert } from '../assert';
import { ScenarioRunner } from '../scenario';

export async function competingBets(
  client: LoadClient,
  runner: ScenarioRunner,
  requests: number,
) {
  const budget = BigInt(requests) < 100n ? BigInt(requests) : 100n;
  const betting = await client.wallet(`${budget}.00`);
  let processed = 0;
  let rejected = 0;
  await runner.run('competingBets', async (index) => {
    const result = await client.call(
      '/wagering/transactions',
      client.wager(betting, 'BET'),
      randomUUID(),
      index,
      [200, 422],
    );
    const data = result.data as { status: string; failureCode?: string };
    if (result.status === 200) {
      assert(data.status === 'PROCESSED', 'Unexpected bet result');
      processed++;
    } else {
      assert(
        data.status === 'REJECTED' && data.failureCode === 'INSUFFICIENT_FUNDS',
        'Unexpected rejection',
      );
      rejected++;
    }
    return result.status;
  });
  assert(
    BigInt(processed) === budget && processed + rejected === requests,
    'Bet concurrency invariant failed',
  );
  await client.check(betting, 0n, processed + 1);

  return budget;
}
