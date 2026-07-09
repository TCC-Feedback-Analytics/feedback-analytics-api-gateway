<!-- Descreva o que este PR muda e por quê. -->

## O que muda



## Mudança de schema de banco? (ADR-0001)

Se este PR altera o schema (tabela, coluna, FK, índice, função, trigger, policy ou view),
o schema vive em **duas representações mantidas à mão** — espelhe nas duas e marque:

- [ ] **`drizzle/schema.ts`** (+ `npm run db:generate` para a migration) — fonte das migrations de produção e dos **tipos que o app importa em runtime**.
- [ ] **`db/schema/*.sql`** (banco local) e **regenerei o golden anti-drift**:
      `npm run db:local:up && node scripts/db-local.mjs && npm run db:drift:snapshot` (commitar `db/schema/.drift-snapshot.sql`).
- [ ] **`db/cutover/*.sql`** — se a mudança precisa ir para produção (Supabase) fora do fluxo Drizzle (SQL idempotente).
- [ ] Se rodei `npm run db:pull`: **reapliquei as 2 linhas de `authUsers`** no topo de `drizzle/schema.ts`.
- [ ] Se mexi nas **tabelas do Better Auth** (`user`/`session`/`account`/`verification`): espelhei nas **3** definições (`drizzle/schema.ts` — fonte única usada pelo adapter — + `db/cutover/betterauth-enable.sql` + `db/schema/tables/public.better_auth.sql`); não há migration tool para elas (ver `db/cutover/README.md`).
- [ ] O CI **`schema-drift`** está verde.

> Por que duas representações? Ver [ADR-0001](../docs/adr/0001-fonte-unica-de-schema.md) — a consolidação numa fonte única é a Fase 2.

## Checklist geral

- [ ] `npm run lint` e testes passam.
- [ ] Documentação atualizada quando aplicável.
