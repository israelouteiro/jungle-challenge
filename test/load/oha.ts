import { mkdir, rm } from 'node:fs/promises';
import { OHA_VERSION, ohaPath } from './oha-release';
export interface OhaReport {
  summary: { total: number; requestsPerSec: number };
  latencyPercentiles: { p50: number; p95: number; p99: number };
  statusCodeDistribution: Record<string, number>;
  errorDistribution: Record<string, number>;
}
export function ohaStatistics(raw: OhaReport, requests: number) {
  const codes = Object.values(raw.statusCodeDistribution);
  const completed = codes.reduce((sum, count) => sum + count, 0);
  const ok = raw.statusCodeDistribution['200'] ?? 0;
  const finite = [
    raw.summary.total,
    raw.summary.requestsPerSec,
    ...Object.values(raw.latencyPercentiles),
  ];
  if (
    finite.some((value) => !Number.isFinite(value) || value < 0) ||
    raw.summary.total <= 0 ||
    codes.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    completed > requests
  )
    throw new Error('Invalid oha report');
  return {
    requests,
    completed,
    errors: requests - ok,
    errorRate: (requests - ok) / requests,
    elapsedMs: raw.summary.total * 1000,
    throughputRps: raw.summary.requestsPerSec,
    p50Ms: raw.latencyPercentiles.p50 * 1000,
    p95Ms: raw.latencyPercentiles.p95 * 1000,
    p99Ms: raw.latencyPercentiles.p99 * 1000,
    statusCounts: raw.statusCodeDistribution,
    transportErrors: raw.errorDistribution,
  };
}
export async function checkOha() {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([ohaPath(), '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch {
    throw new Error(
      'oha not installed: run bun run load:install (or set OHA_BIN)',
    );
  }
  if (!child.stdout || typeof child.stdout === 'number')
    throw new Error('oha stdout is unavailable');
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0 || output.trim() !== `oha ${OHA_VERSION}`)
    throw new Error(`Expected oha ${OHA_VERSION}; run bun run load:install`);
  return output.trim();
}
export async function runOha(options: {
  runId: string;
  name: string;
  urls: string[];
  path: string;
  requests: number;
  concurrency: number;
  body?: unknown;
  key?: string;
}) {
  const prefix = `artifacts/load/${options.runId}-oha-${options.name}`;
  const input = `${prefix}.urls`;
  const output = `${prefix}.json`;
  await mkdir('artifacts/load', { recursive: true });
  await Bun.write(
    input,
    options.urls.map((url) => url + options.path).join('\n') + '\n',
  );
  const args = [
    ohaPath(),
    '--no-tui',
    '--output-format',
    'json',
    '--urls-from-file',
    '-n',
    String(options.requests),
    '-c',
    String(options.concurrency),
    '-t',
    '15s',
  ];
  if (options.body !== undefined)
    args.push(
      '-m',
      'POST',
      '-T',
      'application/json',
      '-d',
      JSON.stringify(options.body),
    );
  if (options.key) args.push('-H', `Idempotency-Key: ${options.key}`);
  args.push(input);
  try {
    const child = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    await Bun.write(output, stdout);
    if (exitCode !== 0)
      throw new Error(
        `oha failed with exit ${exitCode}: ${stderr.slice(0, 500)}`,
      );
    const raw = JSON.parse(stdout) as OhaReport;
    return {
      tool: `oha ${OHA_VERSION}`,
      ...ohaStatistics(raw, options.requests),
      rawReport: output,
    };
  } finally {
    await rm(input, { force: true });
  }
}
