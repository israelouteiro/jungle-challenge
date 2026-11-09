# Guia rápido

### Valores e identificadores

Envie valores monetários como **strings com duas casas decimais** e a moeda da
carteira:

```json
{
  "amount": "25.00",
  "currency": "BRL"
}
```

Use UUIDs para carteiras e jogadores. Datas das respostas seguem o formato ISO-8601.
Esta versão da API não exige token de autenticação.

### Enviar e consultar uma operação

1. Crie uma carteira em `POST /wallets` e guarde o `id` retornado.
2. Envie a operação em `POST /wagering/transactions` com o cabeçalho
   `Idempotency-Key`. Use uma chave única por operação.
3. Para repetir uma requisição, mantenha a mesma chave e o mesmo corpo.
   Alterar o corpo usando a mesma chave retorna `409`.
4. Consulte o saldo atual em `GET /wallets/:walletId`. Uma repetição devolve o
   resultado original, que pode conter um saldo anterior.

### Estados das transações

| Estado              | Significado                                                      |
| ------------------- | ---------------------------------------------------------------- |
| `PROCESSED`         | Operação concluída.                                              |
| `PENDING_REFERENCE` | Aguardando a transação referenciada. Consulte novamente pelo ID. |
| `REJECTED`          | Operação recusada por uma regra de negócio; veja `failureCode`.  |
| `FAILED`            | Falha no processamento; veja `failureCode`.                      |

### Testar os endpoints

Use os formulários de cada rota com IDs criados no seu ambiente. Para requisições
POST, selecione o corpo JSON. Os envios executam operações reais no ambiente aberto.
