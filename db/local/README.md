# Banco local (dev/testes)

Sobe um **Postgres próprio** (+ Mailpit para e-mail) via Docker, sem depender do Supabase — para desenvolver, semear dados e rodar testes de integração **offline**.

## Pré-requisitos
- Docker Desktop rodando.

## Fluxo

```bash
npm run db:local:up      # sobe Postgres (host :5433) + Mailpit (UI :8025, SMTP :1025)
# no .env: DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/feedback
npm run db:reset         # (re)cria o schema + funções/triggers + seed  (exige DATABASE_URL local no .env)
npm run dev              # api em http://localhost:3000
npm run db:local:down    # derruba os containers
```

## Como o schema é aplicado

O schema canônico (`drizzle/0000_*.sql`) foi introspectado do Supabase e usa `auth.uid()`, o schema `auth` e os roles `anon`/`authenticated`. O **shim** [`00-shim.sql`](./00-shim.sql) recria o mínimo desses no Postgres puro para o schema aplicar e a RLS funcionar localmente — **sem** subir GoTrue/Storage/Studio.

- `auth.uid()` lê a variável de sessão `app.current_user_id`. Um teste/rota pode fazer `SET app.current_user_id = '<uuid>'` para simular um usuário autenticado e exercitar a RLS.
- O app conecta como `postgres` (superuser, que **ignora** a RLS) — coerente com o design do `tenantScope` (o isolamento por `enterprise_id` é feito na aplicação; a RLS é rede de segurança).

> **Não** é usado em produção — lá o Supabase provê tudo isso. Este diretório é só para dev.

## Ordem de aplicação (o que o `db:reset` faz)
1. `00-shim.sql` — schema `auth`, `auth.uid()`, roles.
2. `drizzle/0000_*.sql` + `drizzle/0001_*.sql` — tabelas, `auth.users` mínima, FKs, view, policies, índices.
3. funções/triggers portáveis (fingerprint, anti-spam, `updated_at`, validações).
4. seed determinístico (empresas, catálogo, perguntas, feedbacks, análises).

## Fonte do schema (`db/schema/`)

O `scripts/db-local.mjs` aplica os arquivos em [`db/schema/`](../schema) (tabelas, funções, view) — copiados/adaptados do `database/sql/` do repo central para rodar em Postgres puro (ex.: `auth.users` mínima; `ARRAY` → `text[]`). Por ora, o `drizzle/` segue como autoridade de migrations de **produção**; a consolidação das duas representações é passo das fases seguintes da migração.

> Fase 1 do plano de migração: o Better Auth substitui o `auth.users`/GoTrue por tabelas próprias (`user`/`session`/`account`) e o e-mail passa a cair no Mailpit local.
