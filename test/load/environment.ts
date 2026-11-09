import process from 'node:process';
import os from 'node:os';
export function loadEnvironment() {
  const cpus = os.cpus();
  return {
    description:
      process.env.LOAD_ENVIRONMENT ??
      'Local Bun processes; PostgreSQL and SQS endpoint configured by environment',
    loadGenerator: {
      bun: Bun.version,
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      logicalCpus: cpus.length,
      cpuModel: cpus[0]?.model,
      totalMemoryBytes: os.totalmem(),
    },
    tracing: {
      requested: process.env.OTEL_ENABLED === 'true',
      sampleRatio: process.env.OTEL_TRACES_SAMPLER_ARG ?? '1',
    },
    // Versions and hardware above belong to the generator, not necessarily remote LOAD_URLS.
    target: process.env.LOAD_URLS
      ? 'External replicas; target hardware/versions must be supplied in LOAD_ENVIRONMENT'
      : 'Three Bun processes on the load generator host',
    containers: (() => {
      let result: ReturnType<typeof Bun.spawnSync>;
      try {
        result = Bun.spawnSync(['docker', 'info', '--format', '{{json .}}'], {
          stdout: 'pipe',
          stderr: 'ignore',
          timeout: 5000,
        });
      } catch {
        return { available: false };
      }
      if (result.exitCode !== 0 || !result.stdout) return { available: false };
      try {
        const info = JSON.parse(result.stdout.toString()) as {
          ServerVersion: string;
          Architecture: string;
          NCPU: number;
          MemTotal: number;
        };
        return {
          available: true,
          serverVersion: info.ServerVersion,
          arch: info.Architecture,
          cpus: info.NCPU,
          memoryBytes: info.MemTotal,
        };
      } catch {
        return { available: false };
      }
    })(),
  };
}
