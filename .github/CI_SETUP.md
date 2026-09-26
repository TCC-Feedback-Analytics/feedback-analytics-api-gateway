# CI / Deploy — API Gateway

Consome os contratos de `@feedback/lib-shared` (repositório **público**
`feedback-analytics-contracts`, via git tag `v1.0.0`). O `npm ci` clona **sem token**;
os workflows só reescrevem `ssh→https` antes do install (o npm canonicaliza a
dep do GitHub para `git+ssh`, e os runners não têm chave SSH):

```
git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
```

## Secrets (só o deploy usa)

| Secret | Para quê |
|---|---|
| `VERCEL_TOKEN` | Token da conta/projeto Vercel |
| `VERCEL_ORG_ID` | ID da org no Vercel |
| `VERCEL_PROJECT_ID_API_GATEWAY` | ID do projeto Vercel da API |
| `DATABASE_URL` | Conexão PostgreSQL de produção para aplicar migrations antes do deploy (preferir conexão direta ou pooler em modo sessão) |

O **CI** (lint/typecheck/unit) **não precisa de secret** — os testes unitários são mockados. O smoke de migrations (`schema-migrations.yml`) sobe um Postgres efêmero no runner, também sem secret. Os testes de **integração** e **e2e** foram removidos do CI e viraram **testes manuais** (runbook: `feedback-analytics/docs/guias/testes/manuais-api-gateway.md`) — por isso não há mais secrets de banco/fixture E2E aqui.

## Env de runtime (no projeto Vercel)

`DATABASE_URL` (Drizzle — dados **e** Better Auth), o segredo/URL do Better Auth
(`BETTER_AUTH_SECRET`/`BETTER_AUTH_URL`), o SMTP transacional (`SMTP_*` + `MAIL_FROM`)
e a URL/token do serviço `ia-analyze` (`IA_ANALYZE_REMOTE_URL`/`IA_ANALYZE_REMOTE_TOKEN`)
são variáveis de ambiente configuradas nas **Settings do projeto Vercel** da API —
não entram no CI de testes. `DATABASE_URL` também deve ser configurada como secret
do GitHub para o workflow de deploy, apontando para o mesmo banco de produção.
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
