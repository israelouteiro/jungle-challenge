const demo = document.querySelector('#demo');
const load = document.querySelector('#load');
const requests = document.querySelector('#requests');
const concurrency = document.querySelector('#concurrency');
const status = document.querySelector('#status');
const detail = document.querySelector('#detail');
const logs = document.querySelector('#logs');
const error = document.querySelector('#error');
const dashboard = document.querySelector('#dashboard');
dashboard.src = `http://${location.hostname}:3001/d/wagering-overview?orgId=1&from=now-15m&to=now&refresh=1s&kiosk`;
let running = false;
let connected = false;
let streamRevision = 0;
function controls() {
  for (const element of [demo, load, requests, concurrency])
    element.disabled = running || !connected;
}
function render(state) {
  const interrupted = running && !state;
  running = state?.status === 'running';
  controls();
  if (!state) {
    status.textContent = interrupted ? 'Interrompida' : 'Aguardando';
    status.className = interrupted ? 'status failed' : 'status';
    detail.textContent = interrupted
      ? 'Conexão restabelecida sem execução ativa. Consulte os logs em artifacts/presentation/.'
      : 'Selecione um cenário para começar.';
    logs.textContent = 'Os logs aparecerão aqui.';
    return;
  }
  const labels = {
    running: 'Em andamento',
    passed: 'Aprovado',
    failed: 'Falhou',
  };
  status.textContent = labels[state.status];
  status.className = `status ${state.status}`;
  detail.textContent = `${state.input.kind === 'demo' ? 'Demonstração' : 'Carga'} · ${new Date(state.startedAt).toLocaleTimeString('pt-BR')}${state.exitCode === undefined ? '' : ` · saída ${state.exitCode}`}`;
  logs.textContent = state.logs.join('\n') || 'Preparando execução…';
  logs.scrollTop = logs.scrollHeight;
}
const events = new EventSource('/api/events');
events.onopen = () => {
  connected = true;
  error.textContent = '';
  controls();
};
events.onmessage = (event) => {
  streamRevision++;
  render(JSON.parse(event.data));
};
events.onerror = () => {
  connected = false;
  controls();
  error.textContent = 'Reconectando ao controle de testes…';
};
async function start(input) {
  const revision = streamRevision;
  error.textContent = '';
  running = true;
  controls();
  try {
    const response = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const state = await response.json();
    if (!response.ok) throw new Error(state.error);
    // A streamed update is newer than the initial POST snapshot.
    if (streamRevision === revision) render(state);
  } catch (failure) {
    error.textContent = failure.message;
    const recoveryRevision = streamRevision;
    try {
      const state = await fetch('/api/state').then((response) =>
        response.json(),
      );
      if (streamRevision === recoveryRevision) render(state);
    } catch {
      if (streamRevision === recoveryRevision) {
        running = false;
        controls();
      }
    }
  }
}
demo.addEventListener('click', () => start({ kind: 'demo' }));
load.addEventListener('click', () => {
  if (!requests.reportValidity() || !concurrency.reportValidity()) return;
  start({
    kind: 'load',
    requests: Number(requests.value),
    concurrency: Number(concurrency.value),
  });
});
controls();
