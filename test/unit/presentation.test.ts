import { expect, test } from 'bun:test';
import { BusyError, Jobs, parseRun } from '../../scripts/presentation/jobs';

test('presentation accepts only bounded demo/load requests', () => {
  expect(parseRun({ kind: 'demo', command: 'ignored' })).toEqual({
    kind: 'demo',
  });
  expect(parseRun({ kind: 'load', requests: 100, concurrency: 10 })).toEqual({
    kind: 'load',
    requests: 100,
    concurrency: 10,
  });
  for (const input of [
    null,
    { kind: 'shell' },
    { kind: 'load', requests: 2001, concurrency: 10 },
    { kind: 'load', requests: 20, concurrency: 21 },
    { kind: 'load', requests: '100', concurrency: 10 },
  ])
    expect(() => parseRun(input)).toThrow();
});

test('presentation prevents overlapping jobs and streams logs and final state', async () => {
  let finish!: (code: number) => void;
  const gate = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const jobs = new Jobs(async (_input, log) => {
    log('executando');
    return gate;
  });
  const updates: string[] = [];
  const completed = new Promise<void>((resolve) =>
    jobs.subscribe((state) => {
      updates.push(state.status);
      if (state.status !== 'running') resolve();
    }),
  );
  const run = jobs.start({ kind: 'demo' });
  expect(run.logs).toEqual(['executando']);
  expect(() => jobs.start({ kind: 'demo' })).toThrow(BusyError);
  const snapshot = jobs.snapshot()!;
  snapshot.logs.push('alteração externa');
  expect(jobs.snapshot()!.logs).toEqual(['executando']);
  finish(0);
  await completed;
  expect(updates.at(-1)).toBe('passed');
  expect(jobs.snapshot()!.exitCode).toBe(0);
  expect(jobs.snapshot()!.finishedAt).toBeDefined();
});

test('disconnected observers cannot interrupt a job and execution errors become failures', async () => {
  const jobs = new Jobs(async () => {
    throw new Error('erro do processo');
  });
  jobs.subscribe(() => {
    throw new Error('cliente desconectado');
  });
  const completed = new Promise<void>((resolve) =>
    jobs.subscribe((state) => {
      if (state.status === 'failed') resolve();
    }),
  );
  jobs.start({ kind: 'demo' });
  await completed;
  expect(jobs.snapshot()!.status).toBe('failed');
  expect(jobs.snapshot()!.logs).toContain('erro do processo');
});
