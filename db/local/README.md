# Banco local (dev/testes)

Sobe um **Postgres próprio** (+ Mailpit para e-mail) via Docker, sem depender do Supabase — para desenvolver, semear dados e rodar testes de integração/e2e **offline**.

## Pré-requisitos
- Docker Desktop rodando.

## Fluxo

```bash
npm run db:local:up      # sobe Postgres (host :5433) + Mailpit (UI :8025, SMTP :1025)
# no .env: DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/feedback
npm run db:reset         # (re)cria o banco pelas migrations Drizzle + seed  (exige DATABASE_URL local no .env)
npm run dev              # api em http://localhost:3000
npm run db:local:down    # derruba os containers
```

## Como o schema é aplicado

A **fonte única** do schema é o `drizzle/schema.ts` + as migrations versionadas em `drizzle/`:

- `drizzle/0000_*.sql` — tabelas, FKs, índices e a view.
- `drizzle/0001_functions_triggers_rls.sql` — o que o `drizzle-kit` não deriva do schema: funções/triggers `plpgsql`/`sql` (fingerprint, anti-spam, `updated_at`, validações) e o `ENABLE ROW LEVEL SECURITY`.

O `scripts/db-local.mjs` (o que o `db:reset` roda) **não** aplica mais `db/schema/` nem o shim (`00-shim.sql`) — ambos foram removidos. O banco local é construído pela **mesma** sequência de migrations que a produção usaria, via `drizzle-kit migrate`. O schema não depende mais do Supabase: não há schema `auth`, `auth.uid()` nem roles `anon`/`authenticated`; a view lê apenas `public.user`.

> As 4 tabelas do Better Auth (`user`/`session`/`account`/`verification`) vivem só no `drizzle/schema.ts` (o `drizzleAdapter` as consome) e, como o resto do schema, são criadas pelas migrations. Em produção elas entram por `db/cutover/betterauth-enable.sql` (aplicado manualmente).

## Ordem de aplicação (o que o `db:reset` faz)

`db:reset` = `node scripts/db-local.mjs && npm run db:seed:e2e`, nesta ordem:

1. **DROP dos schemas** — `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` + `DROP SCHEMA auth CASCADE;` + `DROP SCHEMA drizzle CASCADE`. Dropar o schema `drizzle` (histórico de migrations) é essencial: sem isso o `migrate` acha que 0000/0001 já rodaram e não recria nada.
2. **`drizzle-kit migrate`** — aplica `0000` (tabelas/FKs/índices/view) + `0001` (funções/triggers/RLS).
3. **`db/local/seed.sql`** — seed determinístico com IDs fixos: duas empresas (A e B) para exercitar o isolamento multi-tenant, catálogo, perguntas, feedbacks e análises. Insere os gestores em `public.user`.
4. **`npm run db:seed:e2e`** (`scripts/seed-e2e-user.ts`) — cria o usuário de teste do e2e do jeito que o Better Auth exige (`user` + `account` com senha bcrypt), provisiona a empresa e marca o e-mail como verificado. Idempotente. O seed SQL do passo 3 só insere linhas em `public.user`, mas não cria a conta/senha (account) que o login exige.

## Segurança

O `scripts/db-local.mjs` faz `DROP SCHEMA` — por isso **recusa** rodar se a `DATABASE_URL` não parecer local (`127.0.0.1`/`localhost`) ou se casar com um host remoto (Supabase, pooler, Neon, AWS, Render, Railway). Nunca aponte o `db:reset` para produção.

O app conecta como `postgres` (superuser), coerente com o design do `tenantScope`: o isolamento por `enterprise_id` é feito na aplicação; a RLS habilitada no `0001` é rede de segurança.

## Variáveis

No `.env` (ver `.env.example`), para o ambiente local:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/feedback

# E-mail transacional via Mailpit (captura sem enviar; UI em http://localhost:8025)
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_SECURE=false
MAIL_FROM=Feedback Analytics <no-reply@feedback.local>

# Better Auth
BETTER_AUTH_SECRET=<gere com: openssl rand -base64 32>
BETTER_AUTH_URL=http://localhost:3000
```

> Portas do Docker (`docker-compose.yml`): Postgres em `5433:5432` (host 5433 evita conflito com outro Postgres na 5432); Mailpit em `8025` (UI) e `1025` (SMTP).

## Fluxo de mudança de schema

Editar `drizzle/schema.ts` → `npm run db:generate` (revisar a migration gerada) → commitar `schema.ts` + a migration + o snapshot. Não há mais espelhamento em `db/schema/` nem guard-rail golden — o CI valida via `.github/workflows/schema-migrations.yml` (sobe Postgres, roda `node scripts/db-local.mjs` e `drizzle-kit check`).
