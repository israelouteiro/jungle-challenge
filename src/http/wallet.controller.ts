import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { OpenWallet } from '../application/use-cases/open-wallet';
import {
  WalletQueries,
  ReconcileWallet,
} from '../application/use-cases/queries';
import { moneyInput, object, uuid } from '../application/contracts';
import { Money } from '../domain/money';
import { DomainError } from '../domain/domain-error';
import { Telemetry } from '../observability/telemetry';
import type { HttpResponse } from './http-response';
import { ProviderIdentityGuard } from './provider-identity.guard';
@Controller()
@UseGuards(ProviderIdentityGuard)
export class WalletController {
  constructor(
    private readonly opening: OpenWallet,
    private readonly wallets: WalletQueries,
    private readonly reconciliation: ReconcileWallet,
    private readonly telemetry: Telemetry,
  ) {}
  /**
   * @api {post} /wallets Criar wallet
   * @apiName OpenWallet
   * @apiGroup Wallets
   * @apiVersion 1.0.0
   * @apiDescription Cria uma carteira por jogador e moeda. Um saldo inicial positivo gera um lançamento de abertura no extrato.
   * @apiBody {String} playerId UUID do jogador.
   * @apiBody {Object} initialBalance Valor de abertura não negativo.
   * @apiBody {String} initialBalance.amount String decimal de duas casas, nunca number.
   * @apiBody {String} initialBalance.currency Código ISO-4217, por exemplo BRL.
   * @apiUse WalletResponse
   * @apiError (400) INVALID_MONEY Valor inválido; exige string decimal com duas casas.
   * @apiError (409) RESOURCE_CONFLICT Wallet já existente para player/moeda.
   * @apiUse ContractErrors
   * @apiExample {json} Corpo:
   * {
   *   "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
   *   "initialBalance": {
   *     "amount": "100.00",
   *     "currency": "BRL"
   *   }
   * }
   * @apiSuccessExample {json} Criada:
   * HTTP/1.1 201 Created
   * {
   *   "id": "0192f291-27dd-7d3f-8071-5f8685deef37",
   *   "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
   *   "balance": {
   *     "amount": "100.00",
   *     "currency": "BRL"
   *   },
   *   "version": 1
   * }
   * @apiSampleRequest /wallets
   */
  @Post('wallets')
  async open(@Body() body: unknown) {
    const data = object(body);
    return this.opening.execute(
      uuid(data.playerId),
      Money.from(moneyInput(data.initialBalance)),
    );
  }
  /**
   * @api {get} /wallets/:walletId Consultar saldo atual
   * @apiName GetWallet
   * @apiGroup Wallets
   * @apiVersion 1.0.0
   * @apiParam {String} walletId UUID da wallet, sem distinção entre maiúsculas/minúsculas.
   * @apiUse WalletResponse
   * @apiUse ContractErrors
   * @apiSampleRequest /wallets/:walletId
   */
  @Get('wallets/:walletId')
  getWallet(@Param('walletId') id: string) {
    return this.wallets.get(uuid(id));
  }
  /**
   * @api {get} /wallets/:walletId/ledger Paginar ledger
   * @apiName GetLedger
   * @apiGroup Wallets
   * @apiVersion 1.0.0
   * @apiParam {String} walletId UUID da wallet, sem distinção entre maiúsculas/minúsculas.
   * @apiQuery {String} [cursor] Cursor opaco retornado em nextCursor; exclusivo da wallet.
   * @apiQuery {Number{1-100}} [limit=50] Tamanho da página.
   * @apiSuccess {Object[]} items Lançamentos imutáveis, ordenados por sequência crescente.
   * @apiSuccess {String} items.id UUID do lançamento.
   * @apiSuccess {String} items.walletId UUID da wallet.
   * @apiSuccess {String} items.transactionId UUID da transação.
   * @apiSuccess {String="DEBIT","CREDIT"} items.direction Direção do movimento.
   * @apiSuccess {Object} items.money Valor positivo (amount string e currency).
   * @apiSuccess {Object} items.balanceBefore Saldo antes do movimento.
   * @apiSuccess {Object} items.balanceAfter Saldo depois do movimento.
   * @apiSuccess {String} items.createdAt Timestamp ISO-8601.
   * @apiSuccess {String} nextCursor Cursor para a próxima página, ou null no fim.
   * @apiUse ContractErrors
   * @apiSuccessExample {json} Fim da paginação:
   * HTTP/1.1 200 OK
   * {
   *   "items": [],
   *   "nextCursor": null
   * }
   * @apiSampleRequest /wallets/:walletId/ledger
   */
  @Get('wallets/:walletId/ledger')
  ledger(
    @Param('walletId') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') requested?: string,
  ) {
    const limit = requested === undefined ? 50 : Number(requested);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new DomainError('INVALID_TRANSACTION');
    return this.wallets.ledger(uuid(id), cursor, limit);
  }
  /**
   * @api {post} /wallets/:walletId/reconciliation Reconciliar saldo e ledger
   * @apiName ReconcileWallet
   * @apiGroup Wallets
   * @apiVersion 1.0.0
   * @apiDescription Compara o saldo da carteira com a soma do extrato, sem alterar dados. Não exige corpo. Retorna HTTP 200 mesmo quando consistent=false; consulte difference para identificar a divergência.
   * @apiParam {String} walletId UUID da wallet, sem distinção entre maiúsculas/minúsculas.
   * @apiSuccess {String} walletId UUID da wallet.
   * @apiSuccess {Object} storedBalance Saldo atual da carteira.
   * @apiSuccess {Object} calculatedBalance Soma exata dos lançamentos.
   * @apiSuccess {Object} difference storedBalance menos calculatedBalance; pode ser negativo.
   * @apiSuccess {Boolean} consistent Indica igualdade exata.
   * @apiSuccess {Number} checkedEntries Quantidade de lançamentos considerados.
   * @apiUse ContractErrors
   * @apiSuccessExample {json} Consistente:
   * HTTP/1.1 200 OK
   * {
   *   "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
   *   "storedBalance": {
   *     "amount": "100.00",
   *     "currency": "BRL"
   *   },
   *   "calculatedBalance": {
   *     "amount": "100.00",
   *     "currency": "BRL"
   *   },
   *   "difference": {
   *     "amount": "0.00",
   *     "currency": "BRL"
   *   },
   *   "consistent": true,
   *   "checkedEntries": 1
   * }
   * @apiSampleRequest /wallets/:walletId/reconciliation
   */
  @Post('wallets/:walletId/reconciliation')
  async reconcile(@Param('walletId') id: string, @Res() res: HttpResponse) {
    const result = await this.reconciliation.execute(uuid(id));
    if (!result.consistent) {
      this.telemetry.increment('reconciliation_mismatches_total');
      this.telemetry.log('reconciliation_mismatch', { walletId: id }, 'error');
    }
    res.status(200).json(result);
  }
}
