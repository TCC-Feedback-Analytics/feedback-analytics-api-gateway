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

**Como chegam em produção:** *só* pelo `betterauth-enable.sql` acima, rodado à mão uma vez. **Não há** ferramenta de migração para elas: não existe `@better-auth/cli` nas dependências, elas ficam **fora** do `drizzle-kit` (não estão em `drizzle/schema.ts`) e o `deploy-api.yml` **não roda migration**. Em runtime o `drizzleAdapter` do Better Auth **consome** as tabelas, mas **não as cria**.

**As mesmas 4 tabelas têm três definições mantidas à mão** — mantenha-as em sincronia:

1. `drizzle/schema.ts` — descrição Drizzle (fonte única) que o `drizzleAdapter` usa em **runtime** (as 4 tabelas com `mode:'date'` nos timestamps).
2. `db/cutover/betterauth-enable.sql` — cria em **produção** (Supabase, manual).
3. `db/schema/tables/public.better_auth.sql` — cria no **banco local** (`db:reset`).

Hoje as três **coincidem** (id `uuid`/`gen_random_uuid()`, `user.phone` UNIQUE, FKs `ON DELETE CASCADE`). O guard-rail `schema-drift` cobre a definição **local** (item 3), mas **não** verifica que (1) e (2) batem com ela. Ao mudar uma dessas tabelas: espelhe nas **três** definições e rode `betterauth-enable.sql` de novo em prod.

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
no dump (`db/schema/tables/public.enterprise.sql`) e é aplicada pelo `db:reset`.

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
