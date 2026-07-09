<!-- Descreva o que este PR muda e por quê. -->

## O que muda



## Mudança de schema de banco? (ADR-0001)

O schema tem **fonte única**: `drizzle/schema.ts` + as migrations em `drizzle/`.
Se este PR altera o schema (tabela, coluna, FK, índice, função, trigger, policy ou view), marque:

- [ ] Editei o schema em **`drizzle/schema/*.ts`** (por domínio; `schema.ts` é só barrel), rodei **`npm run db:generate`**, **revisei** a migration gerada e **commitei** o schema + a migration + o snapshot.
- [ ] Se mexi nas **tabelas do Better Auth** (`user`/`session`/`account`/`verification`): elas vivem em **`drizzle/schema/auth.ts`** (fonte única, consumida pelo `drizzleAdapter`) e, em produção, são criadas pelo **`db/cutover/betterauth-enable.sql`** (manual) — espelhei nas duas (ver `db/cutover/README.md`).
- [ ] O CI **`schema-migrations`** está verde.

> Fluxo single-source: editar `drizzle/schema.ts` → `npm run db:generate` (revisar a migration) → commitar schema + migration + snapshot. Ver [ADR-0001](../docs/adr/0001-fonte-unica-de-schema.md).

## Checklist geral

- [ ] `npm run lint` e testes passam.
- [ ] Documentação atualizada quando aplicável.
