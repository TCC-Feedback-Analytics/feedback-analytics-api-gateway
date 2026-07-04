# CI / Deploy — API Gateway

Consome os contratos de `@feedback/lib-shared` (repositório **público**
`feedback-analytics-contracts`, via git tag). O `npm ci` clona **sem token**;
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

`DATABASE_URL`, URL/token do serviço `ia-analyze`, chaves do Supabase (service
role), etc. são variáveis de ambiente configuradas nas **Settings do projeto
Vercel** da API — não entram no CI.

## Deploy

`workflow_dispatch` (manual, pede `confirm_deploy=ok`). Bundla com esbuild
(`index.ts → _bundle.cjs`) e sobe via `npx vercel deploy --local-config vercel.json`.
Reusa o mesmo projeto Vercel (`VERCEL_PROJECT_ID_API_GATEWAY`) → a **URL da API
não muda**, então o frontend continua apontando pra ela. Branch de staging:
`developer` (deploya no alias `feedback-analytics-api-homolog.vercel.app`).
