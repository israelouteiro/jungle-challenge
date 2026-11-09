import { resolve } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import 'reflect-metadata';
import {
  startTracing,
  inSpan,
  remoteContext,
  SpanKind,
} from './observability/tracing';
import { TracingLifecycle } from './observability/tracing-lifecycle';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import type { Request, Response, NextFunction } from 'express';
import process from 'node:process';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { JsonLogger } from './observability/telemetry';

async function bootstrap(): Promise<void> {
  TracingLifecycle.provider = startTracing();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new JsonLogger(),
  });
  app.enableShutdownHooks();
  app.useStaticAssets(resolve(__dirname, 'apidoc'), { prefix: '/docs/' });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/metrics' || req.path.startsWith('/health/'))
      return next();
    const carrier = Object.fromEntries(
      Object.entries(req.headers).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    void inSpan(
      'http.request',
      SpanKind.SERVER,
      { 'http.request.method': req.method },
      () =>
        new Promise<void>((resolve) => {
          const span = trace.getActiveSpan();
          res.once('close', () => {
            span?.setAttribute('http.response.status_code', res.statusCode);
            if (res.statusCode >= 500)
              span?.setStatus({ code: SpanStatusCode.ERROR });
            if (req.route?.path)
              span?.updateName(`${req.method} ${req.route.path}`);
            resolve();
          });
          next();
        }),
      remoteContext(carrier),
    );
  });
  await app.listen(process.env.PORT ?? 3000);
}

bootstrap().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'bootstrap_failed',
      errorType: error instanceof Error ? error.name : 'Unknown',
    }),
  );
  process.exitCode = 1;
});
