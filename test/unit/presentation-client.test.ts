import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import type { RunState } from '../../scripts/presentation/jobs';

const source = readFileSync(
  new URL('../../scripts/presentation/web/app.js', import.meta.url),
  'utf8',
);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function browser(fetch: (url: string) => Promise<Response>) {
  class Element {
    disabled = false;
    textContent = '';
    className = '';
    src = '';
    scrollTop = 0;
    scrollHeight = 0;
    handlers = new Map<string, () => Promise<void>>();
    addEventListener(event: string, handler: () => Promise<void>) {
      this.handlers.set(event, handler);
    }
  }
  const elements = new Map<string, Element>();
  let connection!: Connection;
  class Connection {
    onopen = () => {};
    onerror = () => {};
    onmessage = (_event: { data: string }) => {};
    constructor() {
      connection = this;
    }
  }
  runInNewContext(source, {
    document: {
      querySelector(selector: string) {
        if (!elements.has(selector)) elements.set(selector, new Element());
        return elements.get(selector);
      },
    },
    location: { hostname: 'localhost' },
    EventSource: Connection,
    fetch,
  });
  connection.onopen();
  return {
    element: (selector: string) => elements.get(selector)!,
    click: () => elements.get('#demo')!.handlers.get('click')!(),
    receive: (state: RunState | null) =>
      connection.onmessage({ data: JSON.stringify(state) }),
    reconnect: () => {
      connection.onerror();
      connection.onopen();
    },
  };
}
const running: RunState = {
  id: 'run-a',
  input: { kind: 'demo' },
  status: 'running',
  startedAt: '2026-11-09T04:00:00.000Z',
  logs: ['iniciado'],
};

test.each(['passed', 'failed'] as const)(
  'delayed POST cannot overwrite %s received over SSE',
  async (status) => {
    const response = deferred<Response>();
    const page = browser(() => response.promise);
    const request = page.click();
    page.receive({
      ...running,
      status,
      exitCode: status === 'passed' ? 0 : 1,
      logs: ['resultado final'],
    });
    response.resolve(Response.json(running));
    await request;
    expect(page.element('#status').textContent).toBe(
      status === 'passed' ? 'Aprovado' : 'Falhou',
    );
    expect(page.element('#logs').textContent).toBe('resultado final');
    expect(page.element('#demo').disabled).toBe(false);
    expect(page.element('#load').disabled).toBe(false);
  },
);

test('empty state after restart clears old output and ignores an older POST response', async () => {
  const response = deferred<Response>();
  const page = browser(() => response.promise);
  const request = page.click();
  page.receive(running);
  page.reconnect();
  page.receive(null);
  response.resolve(Response.json(running));
  await request;
  expect(page.element('#status').textContent).toBe('Interrompida');
  expect(page.element('#detail').textContent).toContain('sem execução ativa');
  expect(page.element('#logs').textContent).not.toContain('iniciado');
  expect(page.element('#demo').disabled).toBe(false);
  expect(page.element('#load').disabled).toBe(false);
});

test('a recovery GET cannot overwrite a newer SSE result', async () => {
  const recovery = deferred<Response>();
  const fetchingRecovery = deferred<void>();
  const page = browser(async (url) => {
    if (url === '/api/runs')
      return Response.json({ error: 'Conflito' }, { status: 409 });
    fetchingRecovery.resolve();
    return recovery.promise;
  });
  const request = page.click();
  await fetchingRecovery.promise;
  page.receive({
    ...running,
    status: 'passed',
    exitCode: 0,
    logs: ['concluído'],
  });
  recovery.resolve(Response.json(running));
  await request;
  expect(page.element('#status').textContent).toBe('Aprovado');
  expect(page.element('#logs').textContent).toBe('concluído');
  expect(page.element('#demo').disabled).toBe(false);
});
