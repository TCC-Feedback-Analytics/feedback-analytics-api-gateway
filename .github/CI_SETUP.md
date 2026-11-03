# CI / Deploy — API Gateway

Consome os contratos de `@feedback/lib-shared` (repositório **público**
`feedback-analytics-contracts`, via git tag `v1.8.0` no `package.json`). O `npm ci` clona **sem token**;
os workflows só reescrevem `ssh→https` antes do install (o npm canonicaliza a
dep do GitHub para `git+ssh`, e os runners não têm chave SSH):

```
git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
```

## Workflows

| Workflow | Gatilho | O que faz |
|---|---|---|
| `ci.yml` | push e PR em `main` e `developer` | Jobs `lint-typecheck` (`npm run lint` + `tsc -p tsconfig.ci.json --noEmit`) e `unit-tests` (`npm test`) |
| `schema-migrations.yml` | push e PR em `main` e `developer` que mexem em `db/**`, `drizzle/**`, `scripts/db-local.mjs`, `docker-compose.yml`, `package*.json` ou no próprio workflow | Sobe o Postgres do `docker-compose.yml`, roda `node scripts/db-local.mjs` e `npm run db:check` |
| `deploy-api.yml` | `workflow_dispatch` | Deploy de produção (seção **Deploy** abaixo) |
| `ia-worker.yml` | `schedule` (`2-59/5 * * * *`, a cada 5 minutos) e `workflow_dispatch` | `POST https://feedback-analytics-api-gateway.vercel.app/api/internal/worker/tick` com o header `x-worker-token`: processa a fila da IA ([operação do worker](../docs/etapa-03-operacao-worker.md)) |

## Secrets (deploy e worker)

| Secret | Para quê |
|---|---|
| `VERCEL_TOKEN` | Token da conta/projeto Vercel |
| `VERCEL_ORG_ID` | ID da org no Vercel |
| `VERCEL_PROJECT_ID_API_GATEWAY` | ID do projeto Vercel da API |
| `DATABASE_URL` | Conexão PostgreSQL de produção para aplicar migrations antes do deploy (preferir conexão direta ou pooler em modo sessão). Usa o `postgres`, dono das tabelas, porque as migrations criam e alteram estrutura |
| `WORKER_TICK_TOKEN` | Enviado pelo `ia-worker.yml` no header `x-worker-token`; precisa ser igual ao `WORKER_TICK_TOKEN` do projeto Vercel |

O **CI** (lint/typecheck/unit) **não precisa de secret** — os testes unitários são mockados. O smoke de migrations (`schema-migrations.yml`) sobe um Postgres efêmero no runner, também sem secret. Os testes de **integração** e **e2e** foram removidos do CI e viraram **testes manuais** (runbook: `feedback-analytics/docs/guias/testes/manuais-api-gateway.md`) — por isso não há mais secrets de banco/fixture E2E aqui.

## Env de runtime (no projeto Vercel)

`DATABASE_URL` (Drizzle — dados **e** Better Auth), o segredo/URL do Better Auth
(`BETTER_AUTH_SECRET`/`BETTER_AUTH_URL`), o SMTP transacional (`SMTP_*` + `MAIL_FROM`)
a URL/token do serviço `ia-analyze` (`IA_ANALYZE_REMOTE_URL`/`IA_ANALYZE_REMOTE_TOKEN`),
o `WORKER_TICK_TOKEN` e a `IA_CONFIG_ENCRYPTION_KEY` são variáveis de ambiente
configuradas nas **Settings do projeto Vercel** da API — não entram no CI de testes.
A lista completa, com o ambiente de cada uma, está no [`.env.example`](../.env.example).
`DATABASE_URL` também deve ser configurada como secret do GitHub para o workflow de
deploy, apontando para o mesmo banco de produção, mas não necessariamente com o mesmo
usuário: na Vercel o app pode entrar como `feedback_app` (só lê e escreve dados), e o
secret do GitHub continua com o `postgres` ([banco com o mínimo de privilégio](../docs/banco-menor-privilegio.md)).
(O Supabase entra apenas como provedor do Postgres, via `DATABASE_URL`;
não há mais `SUPABASE_URL`/`SUPABASE_ANON_KEY`.)

## Deploy

`workflow_dispatch` (manual, pede `confirm_deploy=ok`), aceito **apenas na branch `main`**. Bundla com esbuild
(`index.ts → _bundle.cjs`), executa `npm run db:migrate` e sobe via `npx vercel deploy --prod --local-config vercel.json`,
reusando o mesmo projeto Vercel (`VERCEL_PROJECT_ID_API_GATEWAY`) → o **domínio de produção** é estável.
Não há mais deploy da branch `developer` nem alias de homologação.

Secret `DATABASE_URL` ausente ou migration com erro interrompem o workflow antes
da publicação. Execuções na mesma branch são serializadas sem cancelar o deploy
em andamento, para não interromper a aplicação das migrations. A etapa aplica
somente migrations pendentes; não executa reset nem seed. Se a publicação na
Vercel falhar depois, as migrations já aplicadas permanecem no banco.
