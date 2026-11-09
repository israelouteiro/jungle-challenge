import { randomUUID } from 'node:crypto';
import { assert } from './assert';

export class HttpLoadError extends Error {
  constructor(readonly status: number) {
    super(`Unexpected HTTP ${status}`);
  }
}

export class LoadClient {
  constructor(
    private readonly urls: string[],
    private readonly runId: string,
  ) {}
  async call(
    path: string,
    body?: unknown,
    key?: string,
    index = 0,
    accepted?: number[],
  ) {
    const response = await fetch(this.urls[index % this.urls.length]! + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { 'idempotency-key': key } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (accepted ? !accepted.includes(response.status) : !response.ok)
      throw new HttpLoadError(response.status);
    return { status: response.status, data };
  }
  async wallet(amount = '0.00') {
    return (
      await this.call('/wallets', {
        playerId: randomUUID(),
        initialBalance: { amount, currency: 'BRL' },
      })
    ).data as { id: string; playerId: string };
  }
  wager(owner: { id: string; playerId: string }, kind = 'WIN') {
    return {
      providerId: `load-${this.runId}`,
      externalTransactionId: randomUUID(),
      walletId: owner.id,
      playerId: owner.playerId,
      roundId: 'load',
      gameId: 'load',
      kind,
      money: { amount: '1.00', currency: 'BRL' },
    };
  }
  async check(owner: { id: string }, balance: bigint, entries: number) {
    const result = (await this.call(`/wallets/${owner.id}/reconciliation`, {}))
      .data as {
      consistent: boolean;
      storedBalance: { amount: string };
      checkedEntries: number;
    };
    assert(
      result.consistent &&
        result.storedBalance.amount === `${balance}.00` &&
        result.checkedEntries === entries,
      `Financial invariant failed for ${owner.id}`,
    );
  }
}
