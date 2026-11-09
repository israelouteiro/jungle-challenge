import process from 'node:process';
import { connectDatabase } from '../../src/infrastructure/database/database';
import { isolatedQueues } from '../support/queues';
import { LoadConfiguration } from './configuration';
import { assert } from './assert';

export class LoadRuntime {
  readonly urls: string[];
  private readonly children: ReturnType<typeof Bun.spawn>[] = [];
  private admin: Awaited<ReturnType<typeof connectDatabase>> | undefined;
  private isolatedName: string | undefined;
  private queues: Awaited<ReturnType<typeof isolatedQueues>> | undefined;
  constructor(
    private readonly configuration: LoadConfiguration,
    private readonly runId: string,
  ) {
    this.urls = [...configuration.urls];
  }
  async start(report: Record<string, unknown>) {
    const { external, workersEnabled } = this.configuration;
    const { runId } = this;
    if (!external) {
      this.queues = await isolatedQueues();
      this.admin = await connectDatabase();
      this.isolatedName = `load_${runId.replaceAll('-', '')}`;
      await this.admin.em
        .fork()
        .execute(`CREATE DATABASE "${this.isolatedName}"`);
      const databaseUrl = new URL(
        process.env.DATABASE_URL ??
          'postgresql://jungle:jungle@localhost:5432/jungle',
      );
      databaseUrl.pathname = `/${this.isolatedName}`;
      const isolated = await connectDatabase(databaseUrl.toString());
      try {
        await isolated.migrator.up();
        const [version] = await isolated.em
          .fork()
          .execute<{ version: string }[]>('SELECT version()');
        report.database = {
          name: this.isolatedName,
          version: version!.version,
          initialState: 'empty, migrations applied',
        };
      } finally {
        await isolated.close();
      }
      for (let index = 0; index < 3; index++) {
        const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
        const port = reservation.port!;
        reservation.stop(true);
        this.children.push(
          Bun.spawn([process.execPath, 'dist/main.js'], {
            env: {
              ...process.env,
              DATABASE_URL: databaseUrl.toString(),
              PORT: String(port),
              WORKERS_ENABLED: String(workersEnabled),
              SQS_ENDPOINT: this.queues.configuration.endpoint,
              SQS_QUEUE_URL: this.queues.configuration.incoming,
              SQS_EVENTS_URL: this.queues.configuration.events,
              SQS_DLQ_URL: this.queues.configuration.dlq,
            },
            stdout: 'ignore',
            stderr: 'inherit',
          }),
        );
        this.urls.push(`http://localhost:${port}`);
      }
      // LocalStack exposes only its version here; never copy arbitrary environment/config data into the report.
      try {
        const info = (await (
          await fetch(
            new URL('/_localstack/info', this.queues.configuration.endpoint),
            { signal: AbortSignal.timeout(2000) },
          )
        ).json()) as { version?: string };
        report.broker = {
          implementation: 'LocalStack',
          version: info.version ?? 'not reported',
          isolatedQueues: true,
        };
      } catch {
        report.broker = {
          implementation: 'SQS-compatible endpoint',
          version: 'unavailable',
          isolatedQueues: true,
        };
      }
    }
    for (const url of this.urls) {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          ready = (
            await fetch(url + '/health/ready', {
              signal: AbortSignal.timeout(1000),
            })
          ).ok;
        } catch {}
        if (ready) break;
        await Bun.sleep(100);
      }
      assert(ready, `Application not ready: ${url}`);
    }
  }
  async close(): Promise<string[]> {
    const cleanupErrors: string[] = [];
    try {
      for (const child of this.children)
        if (child.exitCode === null) child.kill('SIGTERM');
      await Promise.all(this.children.map((child) => child.exited));
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    if (this.admin) {
      try {
        if (this.isolatedName)
          await this.admin.em
            .fork()
            .execute(
              `DROP DATABASE IF EXISTS "${this.isolatedName}" WITH (FORCE)`,
            );
      } catch (error) {
        cleanupErrors.push(String(error));
      } finally {
        try {
          await this.admin.close();
        } catch (error) {
          cleanupErrors.push(String(error));
        }
      }
    }
    try {
      await this.queues?.close();
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    return cleanupErrors;
  }
}
