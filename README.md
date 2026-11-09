# Jungle Technical Challenge by IsraelOuteiro

Processador de apostas com NestJS, Bun 1.4.4, PostgreSQL, MikroORM e SQS/LocalStack.
Ledger imutável, controle de concorrência por carteira e idempotência persistente.

## Subir o ambiente

Requisito: Docker com Compose v2. Execute na raiz do projeto, com as portas
3000, 5432 e 4566 livres. Não é necessário instalar Bun no host.

```sh
docker compose --profile app --profile tools up -d --build --wait --scale app=3
```

O comando aplica as migrations e inicia três réplicas da API, gateway Nginx,
PostgreSQL, LocalStack e o container de ferramentas. Use o mesmo comando após
alterar o código para atualizar as imagens.

## Acessar a API

- [Documentação e exemplos das 10 rotas](http://localhost:3000/docs/)
- [Health check](http://localhost:3000/health/ready)
- [Collection Postman](./postman/JungleGaming.postman_collection.json) e
  [ambiente local](./postman/Local.postman_environment.json)

No Postman, use `baseUrl=http://localhost:3000` e execute a collection na ordem.
Esta versão não exige token de autenticação.

## Executar os testes

```sh
docker compose exec -T tools bun run test:all
```

Verifica formatação, tipos, testes unitários e integração; também compila a aplicação
e valida o apiDoc. Os testes usam banco e filas temporários, com limpeza automática.
As três réplicas permanecem ativas durante a execução.

Para validar apenas os oito cenários de concorrência do item 13, com preparação
automática do Docker, execute `./scripts/concurrency/all.sh`.

Para executar a demonstração, use `./scripts/demo.sh`: sobe o ambiente com dashboard
e valida três cenários com chamadas reais. Em [localhost:3002](http://localhost:3002),
inicie demonstração ou carga e acompanhe gráficos e logs ao vivo.

## Encerrar

```sh
docker compose --profile app --profile tools --profile observability down
```

Preserva os dados do PostgreSQL. As filas do LocalStack são efêmeras.

## Documentação complementar

- [Arquitetura e decisões técnicas](./ARCHITECTURE.md)
- [Testes, carga e resultados](./docs/TESTING.md)
- [Desenvolvimento, Docker e observabilidade](./docs/DEVELOPMENT.md)
