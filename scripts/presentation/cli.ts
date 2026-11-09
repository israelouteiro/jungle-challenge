export {};
const origin = 'http://localhost:3002';
const response = await fetch(`${origin}/api/runs`, {
  method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify({ kind: 'demo' }),
});
if (!response.ok) throw new Error(await response.text());
const run = (await response.json()) as { id: string };
const stream = await fetch(`${origin}/api/events`);
let printed = 0;
let pending = '';
const decoder = new TextDecoder();
for await (const chunk of stream.body!) {
  pending += decoder.decode(chunk, { stream: true });
  const events = pending.split('\n\n');
  pending = events.pop()!;
  for (const event of events) {
    if (!event.startsWith('data: ')) continue;
    const state = JSON.parse(event.slice(6)) as {
      id: string;
      status: string;
      logs: string[];
    } | null;
    if (!state || state.id !== run.id) continue;
    for (const line of state.logs.slice(printed)) console.log(line);
    printed = state.logs.length;
    if (state.status !== 'running')
      process.exit(state.status === 'passed' ? 0 : 1);
  }
}
throw new Error('Conexão interrompida antes do resultado');
