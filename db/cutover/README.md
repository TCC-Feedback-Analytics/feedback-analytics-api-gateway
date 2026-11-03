# Cutover Supabase Auth → Better Auth (runbook)

> **Mudança concluída no código.** O Supabase Auth/SDK saiu do gateway em 05/07/2026
> (commit `044c78c`), a reconciliação da Fase 2 foi escrita em 08/07/2026 (`1302cfa`)
> e, desde 10/09/2026 (`b75dc05`), o deploy aplica as migrations pendentes antes de
> publicar. Este runbook fica como **histórico**; os trechos que mudaram depois estão
> marcados. O repositório não registra quando cada SQL abaixo rodou em produção.

Este gateway usa **Better Auth** (sessão via cookie httpOnly) sobre o **Postgres**
(o mesmo Postgres do projeto Supabase, acessado direto por connection string —
`DATABASE_URL`). O Supabase **Auth/SDK** foi removido; o Supabase segue apenas
como **provedor do Postgres**.

## Pré-requisitos em produção (Vercel — projeto api-gateway)

Variáveis de ambiente **obrigatórias** (Settings → Environment Variables → Production):

| Var | O que é |
|---|---|
| `DATABASE_URL` | connection string do Postgres (Supabase → Settings → Database → **pooler**, porta 6543, transação). Todo o app (dados + auth) usa isto. Hoje o app pode entrar com o papel `feedback_app` em vez do `postgres` ([banco com o mínimo de privilégio](../../docs/banco-menor-privilegio.md)). |
| `BETTER_AUTH_SECRET` | segredo aleatório forte: `openssl rand -base64 32`. **Sem ele o `getAuth()` quebra no boot e TODA requisição trava** ("carregando pra sempre"). |
| `BETTER_AUTH_URL` | No cutover, a URL pública do **gateway**. Hoje, em prod, é a URL da **Web**, que repassa `/api/*` ao gateway (ver `.env.example`). |
| `PUBLIC_SITE_URL` | URL pública do **web** (usada em callbacks/redirects). |
| `CORS_ALLOWED_ORIGINS` | origens do web permitidas (CSV). |
| `COOKIE_CROSS_SITE` | `true` se web e api estão em domínios diferentes (cookie `SameSite=None; Secure`). Hoje fica `false` em prod: com a Web repassando `/api/*`, o cookie é do próprio site (ver `.env.example`). |
| `SMTP_HOST` | `smtp-relay.brevo.com` (Brevo). |
| `SMTP_PORT` | `587` (`SMTP_SECURE=false`) — ou `465` (`SMTP_SECURE=true`) se a 587 travar. |
| `SMTP_SECURE` | `false` p/ 587, `true` p/ 465. |
| `SMTP_USER` | o **login SMTP** da conta Brevo (SMTP & API → SMTP). |
| `SMTP_PASS` | uma **chave SMTP** da Brevo, criada em SMTP & API → SMTP keys (não é a API key). |
| `MAIL_FROM` | remetente **verificado** na Brevo (remetente avulso p/ testar, domínio autenticado p/ produção). |

## Passo único no banco (idempotente)

Rode **uma vez** em produção, no Postgres do Supabase (Dashboard → SQL Editor), o script:

```
db/cutover/betterauth-enable.sql
```

Ele cria as tabelas do Better Auth (`user`/`session`/`account`/`verification`),
remove a FK `enterprise.auth_user_id → auth.users` (usuários do Better Auth
vivem em `public.user`) e dropa as policies RLS `auth.uid()` redundantes (o
acesso a dados é 100% via Drizzle, que na época entrava como `postgres`, dono das
tabelas, e por isso ignorava a RLS). É idempotente.

> ⚠️ Este SQL é manual. Na época do cutover o deploy (`deploy-api.yml`) não rodava
> migration; desde 10/09/2026 ele roda `npm run db:migrate`, mas isso não aplica os
> SQLs desta pasta.

## Governança das tabelas do Better Auth (`user`/`session`/`account`/`verification`)

**Como chegaram em produção:** pelo `betterauth-enable.sql` acima, rodado à mão uma vez. Não existe `@better-auth/cli` nas dependências, e em runtime o `drizzleAdapter` do Better Auth **consome** as tabelas, mas **não as cria**.

**Hoje:** a definição é uma só, `drizzle/schema/auth.ts` (re-exportada pelo barrel `drizzle/schema.ts`). É a descrição Drizzle que o `drizzleAdapter` usa em **runtime** (as 4 tabelas com `mode:'date'` nos timestamps) e que o `drizzle-kit` usa para gerar as migrations em `drizzle/` e montar o banco **local** (`db:reset` → `drizzle-kit migrate`). Com o baseline marcado (Fase 2, passo 3) e o deploy rodando `npm run db:migrate`, uma mudança nessas tabelas segue o fluxo normal: edite `drizzle/schema/auth.ts`, gere a migration com `npm run db:generate` e ela chega a produção no próximo deploy ([convenção de migrations](../../docs/migrations-drizzle.md)). É o caso da `0013`, que liga a RLS nelas.

**Antes disso** as 4 tabelas tinham duas definições mantidas à mão em sincronia — `drizzle/schema/auth.ts` e o `betterauth-enable.sql` (id `uuid`/`gen_random_uuid()`, `user.phone` UNIQUE, FKs `ON DELETE CASCADE`) — e cada alteração precisava ser espelhada no SQL e rodada de novo em prod. O `betterauth-enable.sql` não acompanha as migrations posteriores à `0001`.

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
  ('2e14770d14f69fbffcbb35064fa8c372f56d01f1028505d6e0d4f1e99180572c', 1783560214072);  -- 0001_functions_triggers_rls
```

> ⚠️ Os hashes são o **sha256** de `drizzle/0000_great_talisman.sql` e `drizzle/0001_functions_triggers_rls.sql` **deste commit**. Se as migrations forem regeneradas, recompute (`sha256sum drizzle/0000_*.sql drizzle/0001_*.sql`) e use o `when` de `drizzle/meta/_journal.json`.

**4. (Decisão) `deploy-api.yml` passa a rodar `drizzle-kit migrate`?** Com o baseline marcado, mudanças futuras de schema viram `0002+` e podem ser aplicadas por `drizzle-kit migrate` no deploy (fim do SQL manual). Se adotar, adicione um passo `npm run db:migrate` no `deploy-api.yml` (com a `DATABASE_URL` de prod) após o bundle. Até lá, migrations novas são aplicadas à mão.

> **Decidido:** desde 10/09/2026 (`b75dc05`) o `deploy-api.yml` tem o passo **Aplicar migrations de produção**, que roda `npm run db:migrate` com o secret `DATABASE_URL` depois do bundle e antes do `vercel deploy`; secret ausente ou migration com erro interrompem o deploy ([CI / Deploy](../../.github/CI_SETUP.md)).

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
- **Deliverability**: com um remetente avulso de Gmail dá pra testar, mas para
  usuários reais autentique o **domínio** na Brevo (registros DNS).
- **Rollback**: como o modo Supabase foi removido, o rollback é **redeploy do
  commit anterior** no Vercel (Deployments → Promote), não mais por env var.
