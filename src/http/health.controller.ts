import {
  Controller,
  Get,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { FinancialMetrics } from '../infrastructure/database/financial-metrics';
import { Database } from '../infrastructure/database/database';
import { Sqs } from '../infrastructure/messaging/sqs';
import { Telemetry } from '../observability/telemetry';
import type { HttpResponse } from './http-response';
@Controller()
export class HealthController {
  constructor(
    private readonly db: Database,
    private readonly sqs: Sqs,
    private readonly telemetry: Telemetry,
    private readonly financialMetrics: FinancialMetrics,
  ) {}
  /**
   * @api {get} /health/live Liveness
   * @apiName Liveness
   * @apiGroup Operations
   * @apiVersion 1.0.0
   * @apiDescription Confirma que a API está em execução.
   * @apiSuccess {String="ok"} status Processo vivo.
   * @apiSampleRequest /health/live
   */
  @Get('health/live') live() {
    return { status: 'ok' };
  }
  /**
   * @api {get} /health/ready Readiness
   * @apiName Readiness
   * @apiGroup Operations
   * @apiVersion 1.0.0
   * @apiDescription Verifica se o banco de dados e as filas estão disponíveis para atender requisições.
   * @apiSuccess {String="ok"} status Dependências alcançáveis.
   * @apiError (503) DEPENDENCIES_UNAVAILABLE PostgreSQL ou SQS indisponível.
   * @apiErrorExample {json} Indisponível:
   * HTTP/1.1 503 Service Unavailable
   * {
   *   "code": "DEPENDENCIES_UNAVAILABLE"
   * }
   * @apiSampleRequest /health/ready
   */
  @Get('health/ready') async ready() {
    try {
      await Promise.all([
        this.db.orm.em.fork().execute('SELECT 1'),
        this.sqs.ready(),
      ]);
    } catch {
      throw new ServiceUnavailableException({
        code: 'DEPENDENCIES_UNAVAILABLE',
      });
    }
    return { status: 'ok' };
  }
  /**
   * @api {get} /metrics Métricas Prometheus
   * @apiName Metrics
   * @apiGroup Operations
   * @apiVersion 1.0.0
   * @apiDescription Exporta métricas financeiras e operacionais no formato Prometheus (text/plain; version=0.0.4). Ao coletar múltiplas réplicas, use max para estados/transições financeiras e quantidade/idade de eventos pendentes; some os contadores operacionais por processo.
   * @apiSuccessExample {text} Amostra ilustrativa:
   * HTTP/1.1 200 OK
   * Content-Type: text/plain; version=0.0.4
   * jungle_outbox_pending 0
   * jungle_outbox_oldest_pending_age_seconds 0
   * jungle_lock_conflicts_total 0
   * @apiSampleRequest /metrics
   */
  @Get('metrics') async metrics(@Res() res: HttpResponse) {
    const financial = await this.financialMetrics.render();
    res
      .type('text/plain; version=0.0.4')
      .send(financial + this.telemetry.render());
  }
}
