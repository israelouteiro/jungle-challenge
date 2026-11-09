import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ProcessWager } from '../application/use-cases/process-wager';
import { TransactionQueries } from '../application/use-cases/queries';
import { uuid, wagerInput } from '../application/contracts';
import { Telemetry } from '../observability/telemetry';
import type { HttpResponse } from './http-response';
import { ProviderIdentityGuard } from './provider-identity.guard';
@Controller()
@UseGuards(ProviderIdentityGuard)
export class WageringController {
  constructor(
    private readonly processor: ProcessWager,
    private readonly transactions: TransactionQueries,
    private readonly telemetry: Telemetry,
  ) {}
  /**
   * @api {post} /wagering/transactions Submeter operação
   * @apiName SubmitWager
   * @apiGroup Wagering
   * @apiVersion 1.0.0
   * @apiDescription Envia uma aposta, prêmio, perda ou estorno. REFUND estorna um BET; ROLLBACK reverte BET, WIN ou REFUND. Estornos são integrais, únicos por referência e tipo, e devem manter provedor, jogador, carteira, moeda e rodada da operação original. WIN e LOSS podem referenciar um BET. OPENING é exclusivo da criação de carteiras.
   * @apiHeader {String} Idempotency-Key Chave de idempotência; sugestão providerId:externalTransactionId.
   * @apiBody {String} providerId Provedor (1 a 256 caracteres).
   * @apiBody {String} externalTransactionId ID externo (1 a 256 caracteres).
   * @apiBody {String} walletId UUID da wallet.
   * @apiBody {String} playerId UUID do jogador.
   * @apiBody {String} roundId Rodada (1 a 256 caracteres).
   * @apiBody {String} gameId Jogo (1 a 256 caracteres).
   * @apiBody {String="BET","WIN","LOSS","REFUND","ROLLBACK"} kind Tipo da operação.
   * @apiBody {Object} money Valor e moeda.
   * @apiBody {String} money.amount Duas casas; positivo, exceto LOSS que aceita zero.
   * @apiBody {String} money.currency Código ISO-4217 igual ao da wallet.
   * @apiBody {String} [referenceExternalTransactionId] Obrigatório em REFUND/ROLLBACK.
   * @apiSuccess {String} transactionId UUID interno.
   * @apiSuccess {String} status PROCESSED quando aplicada.
   * @apiSuccess {Object} balance Saldo observado nesta operação.
   * @apiSuccess {Boolean} idempotentReplay true quando devolve resultado persistido.
   * @apiSuccess (202) {String} status PENDING_REFERENCE: aguardando a operação referenciada. Consulte o andamento pelo ID.
   * @apiError (409) IDEMPOTENCY_CONFLICT Chave/payload ou identidade externa em conflito.
   * @apiError (422) REJECTED Regra de negócio; resposta contém transactionId, status, balance, failureCode e idempotentReplay.
   * @apiError (500) FAILED Falha de infraestrutura esgotada e já persistida; replay contém failureCode=INFRASTRUCTURE_RETRY_EXHAUSTED.
   * @apiError (400) INVALID_MONEY Valor inválido; exige string decimal com duas casas.
   * @apiUse ContractErrors
   * @apiUse WagerFailureCodes
   * @apiExample {json} Corpo BET:
   * {
   *   "providerId": "provider-a",
   *   "externalTransactionId": "bet-123",
   *   "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
   *   "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
   *   "roundId": "round-123",
   *   "gameId": "game-a",
   *   "kind": "BET",
   *   "money": {
   *     "amount": "25.00",
   *     "currency": "BRL"
   *   }
   * }
   * @apiSuccessExample {json} Aplicada:
   * HTTP/1.1 200 OK
   * {
   *   "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
   *   "status": "PROCESSED",
   *   "balance": {
   *     "amount": "75.00",
   *     "currency": "BRL"
   *   },
   *   "idempotentReplay": false
   * }
   * @apiErrorExample {json} Saldo insuficiente:
   * HTTP/1.1 422 Unprocessable Entity
   * {
   *   "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
   *   "status": "REJECTED",
   *   "balance": {
   *     "amount": "10.00",
   *     "currency": "BRL"
   *   },
   *   "failureCode": "INSUFFICIENT_FUNDS",
   *   "idempotentReplay": false
   * }
   * @apiSampleRequest /wagering/transactions
   */
  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
    @Res() res: HttpResponse,
  ) {
    const started = performance.now();
    try {
      const input = wagerInput(body);
      const result = await this.processor.execute(input, key);
      this.telemetry.increment(
        `wager_requests_total{transport="http",status="${result.status}"}`,
      );
      if (result.idempotentReplay) this.telemetry.increment('duplicates_total');
      this.telemetry.log('transaction_result', {
        correlationId: result.transactionId,
        transactionId: result.transactionId,
        walletId: input.walletId,
        providerId: input.providerId,
      });
      res
        .status(
          result.status === 'FAILED'
            ? 500
            : result.status === 'REJECTED'
              ? 422
              : result.status === 'PENDING_REFERENCE'
                ? 202
                : 200,
        )
        .json(result);
    } finally {
      this.telemetry.observeMilliseconds(performance.now() - started);
    }
  }
  /**
   * @api {get} /wagering/transactions/:transactionId Consultar transação pelo UUID
   * @apiName GetTransaction
   * @apiGroup Wagering
   * @apiVersion 1.0.0
   * @apiParam {String} transactionId UUID interno.
   * @apiUse TransactionView
   * @apiUse ContractErrors
   * @apiSampleRequest /wagering/transactions/:transactionId
   */
  @Get('wagering/transactions/:transactionId')
  transaction(@Param('transactionId') id: string) {
    return this.transactions.byId(uuid(id));
  }
  /**
   * @api {get} /providers/:providerId/wagering/transactions/:externalTransactionId Consultar transação pelo ID externo
   * @apiName GetExternalTransaction
   * @apiGroup Wagering
   * @apiVersion 1.0.0
   * @apiParam {String} providerId ID do provedor.
   * @apiParam {String} externalTransactionId ID externo da operação.
   * @apiUse TransactionView
   * @apiUse ContractErrors
   * @apiSampleRequest /providers/:providerId/wagering/transactions/:externalTransactionId
   */
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  external(
    @Param('providerId') provider: string,
    @Param('externalTransactionId') external: string,
  ) {
    return this.transactions.byExternalId(provider, external);
  }
}
