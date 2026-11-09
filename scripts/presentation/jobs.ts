export type RunInput =
  { kind: 'demo' } | { kind: 'load'; requests: number; concurrency: number };
export interface RunState {
  id: string;
  input: RunInput;
  status: 'running' | 'passed' | 'failed';
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  logs: string[];
}
export function parseRun(value: unknown): RunInput {
  if (!value || typeof value !== 'object') throw new Error('Pedido inválido');
  const input = value as Record<string, unknown>;
  if (input.kind === 'demo') return { kind: 'demo' };
  if (input.kind !== 'load') throw new Error('Escolha demonstração ou carga');
  const { requests, concurrency } = input;
  if (
    typeof requests !== 'number' ||
    !Number.isInteger(requests) ||
    requests < 20 ||
    requests > 2000 ||
    typeof concurrency !== 'number' ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 50 ||
    concurrency > requests
  )
    throw new Error(
      'Carga: 20–2000 requisições por cenário, 1–50 clientes e clientes ≤ requisições',
    );
  return { kind: 'load', requests, concurrency };
}
export class BusyError extends Error {}
export class Jobs {
  private current?: RunState;
  private listeners = new Set<(state: RunState) => void>();
  constructor(
    private readonly execute: (
      input: RunInput,
      log: (line: string) => void,
      id: string,
    ) => Promise<number>,
  ) {}
  snapshot(): RunState | null {
    return this.current
      ? { ...this.current, logs: [...this.current.logs] }
      : null;
  }
  subscribe(listener: (state: RunState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  start(input: RunInput): RunState {
    if (this.current?.status === 'running')
      throw new BusyError('Já existe uma execução em andamento');
    const state: RunState = {
      id: crypto.randomUUID(),
      input,
      status: 'running',
      startedAt: new Date().toISOString(),
      logs: [],
    };
    this.current = state;
    this.publish();
    void this.run(state);
    return this.snapshot()!;
  }
  private async run(state: RunState) {
    const log = (line: string) => {
      state.logs.push(line.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 4000));
      if (state.logs.length > 800) state.logs.shift();
      this.publish();
    };
    try {
      state.exitCode = await this.execute(state.input, log, state.id);
    } catch (error) {
      log(error instanceof Error ? error.message : 'Falha ao executar');
      state.exitCode = 1;
    }
    state.status = state.exitCode === 0 ? 'passed' : 'failed';
    state.finishedAt = new Date().toISOString();
    this.publish();
  }
  private publish() {
    const state = this.snapshot()!;
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        this.listeners.delete(listener);
      }
    }
  }
}
