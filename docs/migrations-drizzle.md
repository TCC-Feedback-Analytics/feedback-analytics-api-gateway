# Migrations com Drizzle (convenção)

> **Em uma frase:** o schema em [`drizzle/schema.ts`](../drizzle/schema.ts) é a **fonte única** da verdade; mudanças nascem como **migrations versionadas** geradas por `drizzle-kit generate` e aplicadas por `drizzle-kit migrate`. Os dumps SQL antigos (no [repositório central](https://github.com/TCC-Feedback-Analytics/feedback-analytics), pasta `database/sql/`) viram **legado**.

Relacionado: [ORM × RLS: nossa decisão](https://github.com/TCC-Feedback-Analytics/feedback-analytics/blob/main/docs/arquitetura/orm-rls-decisao.md).

## Fonte da verdade: uma só representação

> **Decisão:** [ADR-0001](adr/0001-fonte-unica-de-schema.md), consolidada na [Fase 2](adr/0001-plano-fase2-rebaseline.md) — `drizzle/schema.ts` + as migrations em `drizzle/*.sql` são a **fonte única** do schema. Não há mais duas representações mantidas à mão.

Antes da Fase 2 o schema vivia em **dois lugares** que precisavam ser espelhados a cada mudança (`drizzle/` para produção/tipos e `db/schema/*.sql` para o banco local), e um **guard-rail golden** (`db/schema/.drift-snapshot.sql` + `scripts/schema-drift.mjs` + workflow `schema-drift.yml` + scripts `db:drift:*`) mantinha as duas trilhas honestas. **Isso foi aposentado.** Hoje:

- **`drizzle/schema.ts` + `drizzle/*.sql`** é a única fonte. Alimenta as migrations de **produção** e é o schema **tipado que o app importa em runtime** (`src/db/client.ts` + repositories/controllers).
- **O banco local nasce das próprias migrations.** Não existe mais `db/schema/` nem o shim (`db/local/00-shim.sql`) — ambos foram deletados. `db:reset` (via [`scripts/db-local.mjs`](../scripts/db-local.mjs)) faz **DROP** dos schemas `public`/`auth`/`drizzle` → **`drizzle-kit migrate`** → aplica [`db/local/seed.sql`](../db/local/seed.sql) → `db:seed:e2e`. Ou seja, o local é montado exatamente pelas mesmas migrations que vão para produção.

**Guard-rail (CI):** [`.github/workflows/schema-migrations.yml`](../.github/workflows/schema-migrations.yml) (`Migrations smoke`) sobe um Postgres, roda `node scripts/db-local.mjs` (DROP → migrate → seed) e roda `drizzle-kit check`. Se as migrations não aplicam limpo, ou se `schema.ts` e os snapshots divergem, o CI quebra. Não há mais golden a regenerar.

**As 4 tabelas Better Auth** (`public.user/session/account/verification`) vivem **só** em `drizzle/schema.ts` (fonte única; o `drizzleAdapter` as consome — `src/auth/schema.ts` foi deletado). Em produção elas são criadas manualmente por [`db/cutover/betterauth-enable.sql`](../db/cutover/betterauth-enable.sql).

## Estrutura da pasta `drizzle/`

| Arquivo | Papel |
|---|---|
| `schema.ts` | **Fonte única** do schema (mantido à mão; alimenta `generate` e o runtime do app). |
| `relations.ts` | Relações para a query API do Drizzle (gerado; opcional). |
| `0000_great_talisman.sql` | **Baseline (re-baseline da Fase 2)** — tabelas, FKs, índices e a view `enterprise_public`, refletindo o estado **pós-cutover** (inclui as tabelas Better Auth; sem dependência de `auth.users`). |
| `0001_functions_triggers_rls.sql` | Migration **custom** — funções (plpgsql/sql), triggers e `ENABLE RLS` que o `drizzle-kit` não deriva. |
| `meta/_journal.json` + `meta/*_snapshot.json` | Histórico e snapshots usados pelo `generate` para fazer o diff. |

## Scripts (`package.json` da raiz)

| Comando | O que faz | Precisa do banco? |
|---|---|---|
| `npm run db:pull` | Introspecta o banco → regenera `schema.ts` | sim (leitura) |
| `npm run db:generate` | Faz o **diff** schema × último snapshot → nova migration SQL | **não** (offline) |
| `npm run db:migrate` | Aplica as migrations pendentes no banco | sim |
| `npm run db:check` | Valida consistência das migrations | não |
| `npm run db:reset` | Recria o banco **local** do zero: DROP → `drizzle-kit migrate` → `db/local/seed.sql` → `db:seed:e2e` | sim (local) |
| `npm run db:studio` | Abre o Drizzle Studio | sim |
| `npm run verify:stats` | Confere as agregações de estatística servidas via Drizzle | sim (leitura) |

## Fluxo de uma mudança de schema (daqui pra frente)

1. Edite `drizzle/schema.ts` (ex.: adicione uma coluna, índice, tabela).
2. `npm run db:generate` → cria `drizzle/000N_*.sql` (**revise o SQL!**).
3. `npm run db:migrate` (produção) ou `npm run db:reset` (recria o local) → aplica.
4. Commit do `schema.ts` + da migration + do snapshot juntos.

> O `db:generate` é **offline** e seguro de rodar a qualquer momento. **Sempre revise** o SQL gerado antes de aplicar. Não há mais nada a espelhar em `db/schema` nem golden a atualizar.

## Baseline: re-baseline da Fase 2

Originalmente o Drizzle foi adotado sobre um banco **já populado** (Supabase), e o `0000` descrevia o que já estava lá — exigindo marcar o baseline como "já aplicado" antes do primeiro `migrate`. **Na Fase 2 o baseline foi re-baseleado:** o `0000` foi regerado para refletir o estado **pós-cutover** e o `0001` passou a carregar as partes que o `drizzle-kit` não deriva. Consequências:

- **`0000_great_talisman.sql`** cria tabelas, FKs, índices e a view — incluindo as 4 tabelas Better Auth. A view `enterprise_public` lê **só** `public.user`; o schema **não depende mais de `auth.users`**, e as funções legadas do Supabase foram removidas.
- **`0001_functions_triggers_rls.sql`** é uma migration custom com as funções (corpos plpgsql/sql), triggers e `ENABLE RLS`.
- Como o banco local agora **nasce das migrations** (`db:reset`), **não há passo manual de baseline**: as duas migrations são aplicadas do zero em cada recriação. Em produção, o histórico de cutover fica documentado em [`db/cutover/README.md`](../db/cutover/README.md).

## Decisões e ressalvas (honestas)

- **Sem `auth.users` no schema:** o re-baseline eliminou a dependência do schema `auth` do Supabase. Os usuários da aplicação vivem em `public.user` (Better Auth), a view `enterprise_public` lê só `public.user`, e as FKs cruzadas que apontavam para `auth.users` foram reconciliadas. Os arquivos em `db/cutover/*` permanecem como **histórico** do cutover, não como fonte ativa.
- **Imperfeições da introspecção corrigidas:** o `db:pull` produzia pequenas imperfeições (CHECKs marcados `NOT VALID` e as *operator classes* de índices embaralhadas). **Foram corrigidas no re-baseline** — o `0000` já sai consistente, e recriar o banco do zero reproduz o estado canônico.
- **Dumps SQL legados:** os dumps SQL antigos (no repositório central de docs, `database/sql/`) param de ser a fonte da verdade do schema. Ficam como referência/histórico; mudanças novas de schema nascem como migration Drizzle **neste repositório**.

## O que isso demonstra no TCC

- **Migrations versionadas** com histórico e diff automático (declarativo), em vez de SQL escrito à mão.
- **Fonte única de schema** — uma só representação (`schema.ts` + migrations), com o banco local montado pelas mesmas migrations que vão para produção.
- **Adoção de ORM sobre banco existente** — o problema real de *baseline* e o re-baseline consciente na Fase 2 ([ADR-0001](adr/0001-fonte-unica-de-schema.md) · [plano da Fase 2](adr/0001-plano-fase2-rebaseline.md)).
