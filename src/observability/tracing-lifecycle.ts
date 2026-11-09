import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import type { TracerProvider } from '@opentelemetry/sdk-trace';
@Injectable()
export class TracingLifecycle implements OnApplicationShutdown {
  static provider: TracerProvider | undefined;
  async onApplicationShutdown(): Promise<void> {
    await TracingLifecycle.provider?.shutdown();
  }
}
