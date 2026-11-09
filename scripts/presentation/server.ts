import { mkdir, writeFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { BusyError, Jobs, parseRun } from './jobs';
import type { RunInput } from './jobs';

let active: ReturnType<typeof Bun.spawn> | undefined;
function displayLine(line: string): string {
  try {
    const data = JSON.parse(line) as Record<string, unknown>;
    if ((data.scenario || data.httpBenchmark) && typeof data.p95Ms === 'number')
      return `[${data.httpBenchmark ? 'oha' : 'Bun'}] ${data.scenario ?? data.httpBenchmark} · ${data.completed}/${data.requests} chamadas · p95 ${data.p95Ms.toFixed(1)} ms · erros ${data.errors}`;
  } catch {
    /* Plain output is already readable. */
  }
  return line;
}
async function execute(
  input: RunInput,
  log: (line: string) => void,
  id: string,
) {
  // Resolve every replica explicitly; the load runner then rotates through all three.
  const replicas = await lookup('app', { all: true, family: 4 });
  const urls = replicas
    .map(({ address }) => `http://${address}:3000`)
    .join(',');
  const command =
    input.kind === 'demo'
      ? [process.execPath, 'scripts/presentation/demo.ts']
      : [process.execPath, 'test/load/run.ts'];
  log(
    input.kind === 'demo'
      ? 'Demonstração: concorrência, replay e referência fora de ordem.'
      : `Carga: ${input.requests} requisições por cenário; ${input.concurrency} clientes.`,
  );
  log(
    `Destino: ${replicas.length} réplicas reais do ambiente. Dados serão preservados.`,
  );
  const child = Bun.spawn(command, {
    env: {
      ...process.env,
      LOAD_URLS: urls,
      LOAD_EXPECT_DRAIN: 'true',
      ...(input.kind === 'load' && {
        LOAD_REQUESTS: String(input.requests),
        LOAD_CONCURRENCY: String(input.concurrency),
      }),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  active = child;
  const timer = setTimeout(() => {
    log('Prazo de 5 minutos esgotado.');
    child.kill('SIGTERM');
  }, 300000);
  const lines: string[] = [];
  async function read(stream: ReadableStream<Uint8Array>) {
    let pending = '';
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      const complete = pending.split('\n');
      pending = complete.pop()!;
      for (const line of complete) {
        lines.push(line);
        log(displayLine(line));
      }
    }
    pending += decoder.decode();
    if (pending) {
      lines.push(pending);
      log(displayLine(pending));
    }
  }
  try {
    const [code] = await Promise.all([
      child.exited,
      read(child.stdout),
      read(child.stderr),
    ]);
    await mkdir('artifacts/presentation', { recursive: true });
    await writeFile(`artifacts/presentation/${id}.log`, lines.join('\n'));
    log(`Log: artifacts/presentation/${id}.log`);
    return code;
  } finally {
    clearTimeout(timer);
    active = undefined;
  }
}
const jobs = new Jobs(execute);
const files = new Map([
  ['/', new URL('./web/index.html', import.meta.url)],
  ['/app.js', new URL('./web/app.js', import.meta.url)],
  ['/style.css', new URL('./web/style.css', import.meta.url)],
]);
const security = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src http://localhost:3001 http://127.0.0.1:3001; frame-ancestors 'none'",
};
function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: security });
}
const server = Bun.serve({
  port: 3002,
  hostname: '0.0.0.0',
  idleTimeout: 30,
  maxRequestBodySize: 4096,
  async fetch(request) {
    const url = new URL(request.url);
    if (!['localhost', '127.0.0.1'].includes(url.hostname))
      return json({ error: 'Host inválido' }, 403);
    if (request.method === 'POST') {
      if (
        request.headers.get('origin') !== url.origin ||
        request.headers.get('content-type')?.split(';')[0] !==
          'application/json'
      )
        return json({ error: 'Origem inválida' }, 403);
      if (url.pathname !== '/api/runs')
        return json({ error: 'Rota inexistente' }, 404);
      try {
        return json(jobs.start(parseRun(await request.json())), 202);
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : 'Pedido inválido' },
          error instanceof BusyError ? 409 : 400,
        );
      }
    }
    if (request.method !== 'GET')
      return json({ error: 'Método inválido' }, 405);
    if (url.pathname === '/api/health') return json({ status: 'ok' });
    if (url.pathname === '/api/state') return json(jobs.snapshot());
    if (url.pathname === '/api/events') {
      let close: (() => void) | undefined;
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          const send = (state: unknown) =>
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(state)}\n\n`),
            );
          send(jobs.snapshot());
          const unsubscribe = jobs.subscribe(send);
          const heartbeat = setInterval(
            () => controller.enqueue(encoder.encode(': keepalive\n\n')),
            15000,
          );
          close = () => {
            clearInterval(heartbeat);
            unsubscribe();
          };
        },
        cancel() {
          close?.();
        },
      });
      return new Response(stream, {
        headers: {
          ...security,
          'Content-Type': 'text/event-stream',
          Connection: 'keep-alive',
        },
      });
    }
    const file = files.get(url.pathname);
    return file
      ? new Response(Bun.file(file), { headers: security })
      : json({ error: 'Rota inexistente' }, 404);
  },
});
process.on('SIGTERM', async () => {
  active?.kill('SIGTERM');
  await server.stop(true);
  process.exit(0);
});
console.log('Painel de apresentação: http://localhost:3002');
