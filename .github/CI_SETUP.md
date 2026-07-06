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

O **CI** (lint/typecheck/unit) **não precisa de secret** — os testes são mockados.

## Env de runtime (no projeto Vercel, NÃO como GitHub secret)

`DATABASE_URL` (Drizzle — dados **e** Better Auth), o segredo/URL do Better Auth
(`BETTER_AUTH_SECRET`/`BETTER_AUTH_URL`), o SMTP transacional (`SMTP_*` + `MAIL_FROM`)
e a URL/token do serviço `ia-analyze` (`IA_ANALYZE_REMOTE_URL`/`IA_ANALYZE_REMOTE_TOKEN`)
são variáveis de ambiente configuradas nas **Settings do projeto Vercel** da API —
não entram no CI. (O Supabase entra apenas como provedor do Postgres, via `DATABASE_URL`;
não há mais `SUPABASE_URL`/`SUPABASE_ANON_KEY`.)

## Deploy

`workflow_dispatch` (manual, pede `confirm_deploy=ok`). Bundla com esbuild
(`index.ts → _bundle.cjs`) e sobe via `npx vercel deploy --local-config vercel.json`.
Reusa o mesmo projeto Vercel (`VERCEL_PROJECT_ID_API_GATEWAY`), mantendo estáveis
o **domínio de produção** (`main`, `--prod`) e o **alias fixo de homologação** — o
deploy de preview em si gera uma URL nova a cada run, por isso o alias é fixado. O
frontend aponta para o alias/domínio, não para a URL de preview. Branch de staging:
`developer` (deploya e fixa o alias `feedback-analytics-api-homolog.vercel.app`).
