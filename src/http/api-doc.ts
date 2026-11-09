/**
 * @apiDefine ContractErrors
 * @apiError (400) INVALID_TRANSACTION Contrato, UUID, cursor ou limite inválido.
 * @apiError (404) RESOURCE_NOT_FOUND Recurso inexistente.
 * @apiError (500) INTERNAL_ERROR Falha interna no processamento.
 * @apiError (503) INFRASTRUCTURE_UNAVAILABLE Falha transitória de infraestrutura; retryable=true.
 * @apiErrorExample {json} Infraestrutura transitória:
 * HTTP/1.1 503 Service Unavailable
 * {
 *   "code": "INFRASTRUCTURE_UNAVAILABLE",
 *   "retryable": true
 * }
 */
/**
 * @apiDefine WalletResponse
 * @apiSuccess {String} id UUID da wallet.
 * @apiSuccess {String} playerId UUID do jogador.
 * @apiSuccess {Object} balance Saldo atual da carteira.
 * @apiSuccess {String} balance.amount Valor decimal com exatamente duas casas.
 * @apiSuccess {String} balance.currency Código ISO-4217.
 * @apiSuccess {Number} version Inicia em 1; incrementa somente quando o saldo muda.
 */
/**
 * @apiDefine TransactionView
 * @apiSuccess {String} transactionId UUID interno.
 * @apiSuccess {String} providerId Identificador do provedor.
 * @apiSuccess {String} externalTransactionId Identificador no provedor.
 * @apiSuccess {String} walletId Wallet da operação.
 * @apiSuccess {String} playerId Jogador da operação.
 * @apiSuccess {String} roundId Rodada.
 * @apiSuccess {String} gameId Jogo.
 * @apiSuccess {String} kind Tipo da operação, incluindo OPENING interno nas consultas.
 * @apiSuccess {Object} money Valor contratado (amount string e currency ISO-4217).
 * @apiSuccess {String} status Estado atual da transação.
 * @apiSuccess {Object} [balance] Saldo observado no resultado persistido; não necessariamente o saldo atual.
 * @apiSuccess {String} [failureCode] Motivo estável de rejeição/falha; consulte os códigos em POST /wagering/transactions.
 * @apiSuccess {String} [referenceExternalTransactionId] Referência externa informada.
 * @apiSuccess {String} [referenceTransactionId] Referência interna resolvida.
 * @apiSuccess {String} createdAt Timestamp ISO-8601.
 * @apiSuccess {String} [processedAt] Timestamp ISO-8601 da aplicação.
 * @apiSuccess {Boolean} [idempotentReplay] Indica repetição no resultado original. Esta consulta não reenvia a operação.
 */
/**
 * @apiDefine WagerFailureCodes
 * @apiError (400) INVALID_REFERENCE Referência obrigatória ausente ou inválida; corrija o pedido.
 * @apiError (422) INVALID_MONEY Valor fora dos limites financeiros.
 * @apiError (422) INVALID_TRANSACTION Operação incompatível com o jogador ou com as regras do tipo informado.
 * @apiError (422) CURRENCY_MISMATCH Moeda diferente da carteira ou da referência.
 * @apiError (422) INSUFFICIENT_FUNDS Saldo insuficiente para a aposta.
 * @apiError (422) REVERSAL_INSUFFICIENT_FUNDS Saldo insuficiente para reverter um crédito.
 * @apiError (422) INVALID_REFERENCE Referência incompatível em tipo, valor, carteira, jogador, provedor, moeda ou rodada.
 * @apiError (422) REFERENCE_NOT_PROCESSED Referência encontrada, mas sem processamento bem-sucedido.
 * @apiError (422) REFERENCE_NOT_FOUND Referência ausente após esgotar tentativas ou prazo de espera.
 * @apiError (422) REFERENCE_ALREADY_REVERSED Reversão desse tipo já aplicada à referência.
 * @apiError (422) failureCode Os códigos de rejeição ficam em failureCode e são persistidos. Reenviar a mesma chave retorna a mesma rejeição; uma operação corrigida exige nova identidade e chave.
 * @apiError (500) INFRASTRUCTURE_RETRY_EXHAUSTED failureCode de uma transação FAILED após esgotar retries de infraestrutura. O replay preserva essa falha; investigue antes de criar outra operação.
 */
