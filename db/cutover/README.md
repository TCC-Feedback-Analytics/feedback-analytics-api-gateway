# Cutover Supabase Auth → Better Auth (runbook)

Este gateway usa **Better Auth** (sessão via cookie httpOnly) sobre o **Postgres**
(o mesmo Postgres do projeto Supabase, acessado direto por connection string —
`DATABASE_URL`). O Supabase **Auth/SDK** foi removido; o Supabase segue apenas
como **provedor do Postgres**.

## Pré-requisitos em produção (Vercel — projeto api-gateway)

Variáveis de ambiente **obrigatórias** (Settings → Environment Variables → Production):

| Var | O que é |
|---|---|
| `DATABASE_URL` | connection string do Postgres (Supabase → Settings → Database → **pooler**, porta 6543, transação). Todo o app (dados + auth) usa isto. |
| `BETTER_AUTH_SECRET` | segredo aleatório forte: `openssl rand -base64 32`. **Sem ele o `getAuth()` quebra no boot e TODA requisição trava** ("carregando pra sempre"). |
| `BETTER_AUTH_URL` | URL pública do **gateway** em prod (ex.: `https://…api….vercel.app`). |
| `PUBLIC_SITE_URL` | URL pública do **web** (usada em callbacks/redirects). |
| `CORS_ALLOWED_ORIGINS` | origens do web permitidas (CSV). |
| `COOKIE_CROSS_SITE` | `true` se web e api estão em domínios diferentes (cookie `SameSite=None; Secure`). |
| `SMTP_HOST` | `smtp.sendgrid.net` (SendGrid). |
| `SMTP_PORT` | `587` (`SMTP_SECURE=false`) — ou `465` (`SMTP_SECURE=true`) se a 587 travar. |
| `SMTP_SECURE` | `false` p/ 587, `true` p/ 465. |
| `SMTP_USER` | `apikey` (literal — é assim no SendGrid). |
| `SMTP_PASS` | a **API Key do SendGrid** (`SG.…`), criada em Settings → API Keys (permissão Mail Send). |
| `MAIL_FROM` | remetente **verificado** no SendGrid (Single Sender p/ testar, Domain Authentication p/ produção). |

## Passo único no banco (idempotente)

Rode **uma vez** em produção, no Postgres do Supabase (Dashboard → SQL Editor), o script:

```
db/cutover/betterauth-enable.sql
```

Ele cria as tabelas do Better Auth (`user`/`session`/`account`/`verification`),
remove a FK `enterprise.auth_user_id → auth.users` (usuários do Better Auth
vivem em `public.user`) e dropa as policies RLS `auth.uid()` redundantes (o
acesso a dados é 100% via Drizzle, que ignora a RLS). É idempotente.

> ⚠️ O deploy (`deploy-api.yml`) **não** roda migration — este SQL é manual.

## Governança das tabelas do Better Auth (`user`/`session`/`account`/`verification`)

**Como chegam em produção:** *só* pelo `betterauth-enable.sql` acima, rodado à mão uma vez. O `deploy-api.yml` **não roda migration** e não existe `@better-auth/cli` nas dependências, então nada aplica automaticamente essas tabelas em prod. Em runtime o `drizzleAdapter` do Better Auth **consome** as tabelas, mas **não as cria**.

**As mesmas 4 tabelas têm duas definições** — mantenha-as em sincronia:

1. `drizzle/schema.ts` — **fonte única**. É a descrição Drizzle que o `drizzleAdapter` usa em **runtime** (as 4 tabelas com `mode:'date'` nos timestamps) e que o `drizzle-kit` usa para gerar as migrations em `drizzle/` e montar o banco **local** (`db:reset` → `drizzle-kit migrate`).
2. `db/cutover/betterauth-enable.sql` — cria em **produção** (Supabase, manual).

As duas **coincidem** (id `uuid`/`gen_random_uuid()`, `user.phone` UNIQUE, FKs `ON DELETE CASCADE`). Não há guard-rail automático verificando que (1) e (2) batem entre si: o `betterauth-enable.sql` é mantido à mão. Ao mudar uma dessas tabelas, edite primeiro `drizzle/schema.ts` (gere a migration com `npm run db:generate`), **espelhe** a alteração no `betterauth-enable.sql` e rode-o de novo em prod.

> ⚠️ `CREATE TABLE IF NOT EXISTS` **não altera** uma tabela que já existe — para adicionar/alterar coluna numa dessas tabelas em produção é preciso escrever o `ALTER TABLE` correspondente (não basta editar o `CREATE`). A consolidação numa fonte única (Drizzle) está no [ADR-0001](../../docs/adr/0001-fonte-unica-de-schema.md).

## Complemento — FK de deleção por usuário (recomendado)

O `betterauth-enable.sql` **removeu** a FK `enterprise.auth_user_id → auth.users`
mas **não** recriou apontando para `public.user`. Sem ela, deletar um usuário
(`public.user`) **não** cascateia para a empresa — a `enterprise` e todos os
dados de negócio ficam órfãos. Para fechar essa lacuna, rode (uma vez, idempotente):

```
db/cutover/enterprise-user-fk.sql
```

Ele recria a FK `enterprise.auth_user_id → public.user` com **`ON DELETE CASCADE`**
(deletar o usuário apaga a empresa → e a cascata da empresa apaga feedbacks,
catálogo, pontos de coleta, etc.). É seguro em bases grandes: adiciona a FK como
`NOT VALID` e só a `VALIDATE` se não houver empresas órfãs — se houver, avisa
quais são e como validar depois de limpá-las. No banco **local** essa FK já vem
definida em `drizzle/schema.ts` (migration `0000` em `drizzle/`) e é aplicada pelo
`db:reset` via `drizzle-kit migrate`.

## Fase 2 — reconciliação em produção (Passo 8)

O re-baseline da Fase 2 ([ADR-0001](../../docs/adr/0001-fonte-unica-de-schema.md)) tornou `drizzle/schema.ts` + as migrations a **fonte única**. Em produção — onde o schema foi montado à mão pelos SQLs de cutover acima — estes passos alinham prod ao novo baseline. **Faça backup antes.**

**1. Backup:** `pg_dump` completo de produção (Supabase → Database → Backups, ou `pg_dump "$DATABASE_URL"`).

**2. Reconciliar o schema** (remove os resíduos do Supabase Auth: view com fallback, funções legadas, FK `blocked_by`). Idempotente:

```
db/cutover/fase2-prod-reconcile.sql
```

**3. Marcar o baseline como aplicado** — para o `drizzle-kit migrate` futuro **não** tentar recriar o que já existe. Prod já tem as tabelas/funções, então registramos `0000` e `0001` como aplicados (sem rodá-los). No SQL Editor:

```sql
CREATE SCHEMA IF NOT EXISTS drizzle;
CREATE TABLE IF NOT EXISTS drizzle."__drizzle_migrations" (
  id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
);
INSERT INTO drizzle."__drizzle_migrations" (hash, created_at) VALUES
  ('b7e03e1bab11ffa2a7a389ac45ed9300256cba9714f9b6fc647ec42d7bd0ff68', 1783560212472),  -- 0000_great_talisman
  ('b3687d600dc52840b0aa52218bc6aaf6b99aff15d01f633741669cb5ed2fd98f', 1783560214072);  -- 0001_functions_triggers_rls
```

> ⚠️ Os hashes são o **sha256** de `drizzle/0000_great_talisman.sql` e `drizzle/0001_functions_triggers_rls.sql` **deste commit**. Se as migrations forem regeneradas, recompute (`sha256sum drizzle/0000_*.sql drizzle/0001_*.sql`) e use o `when` de `drizzle/meta/_journal.json`.

**4. (Decisão) `deploy-api.yml` passa a rodar `drizzle-kit migrate`?** Com o baseline marcado, mudanças futuras de schema viram `0002+` e podem ser aplicadas por `drizzle-kit migrate` no deploy (fim do SQL manual). Se adotar, adicione um passo `npm run db:migrate` no `deploy-api.yml` (com a `DATABASE_URL` de prod) após o bundle. Até lá, migrations novas são aplicadas à mão.

**5. Validar:** login/signup, o formulário público (QR) resolve o nome via view, e um `drizzle-kit migrate` não acusa migrations pendentes inesperadas.

## Ordem do cutover

1. Setar as envs acima no Vercel.
2. Rodar `betterauth-enable.sql` no Postgres.
3. Deploy do api-gateway.
4. Testar login/signup.

## Notas operacionais

- **E-mail de verificação é fire-and-forget**: se o envio falhar, o signup ainda
  cria a conta (porém `email_verified=false` → não loga). Para destravar um teste:
  `UPDATE public."user" SET email_verified = true WHERE lower(email) = '<email>';`
- **Deliverability**: com Single Sender de um Gmail dá pra testar, mas para
  usuários reais faça **Domain Authentication** no SendGrid (registros DNS).
- **Rollback**: como o modo Supabase foi removido, o rollback é **redeploy do
  commit anterior** no Vercel (Deployments → Promote), não mais por env var.
