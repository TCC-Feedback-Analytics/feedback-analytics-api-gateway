<!-- Descreva o que este PR muda e por quê. -->

## O que muda



## Mudança de schema de banco? (ADR-0001)

O schema tem **fonte única**: `drizzle/schema.ts` + as migrations em `drizzle/`.
Se este PR altera o schema (tabela, coluna, FK, índice, função, trigger, policy ou view), marque:

- [ ] Editei o schema em **`drizzle/schema/*.ts`** (por domínio; `schema.ts` é só barrel), rodei **`npm run db:generate`**, **revisei** a migration gerada e **commitei** o schema + a migration + o snapshot.
- [ ] Se mexi nas **tabelas do Better Auth** (`user`/`session`/`account`/`verification`): editei **`drizzle/schema/auth.ts`** (fonte única, consumida pelo `drizzleAdapter`) e gerei a migration. Não mexi no `db/cutover/betterauth-enable.sql`, que é histórico.
- [ ] O CI **Migrations smoke** (job `migrations-smoke`) está verde.

> Fluxo da fonte única: edite o arquivo do domínio em `drizzle/schema/`, rode `npm run db:generate`, revise a migration e faça o commit do schema, da migration e do snapshot juntos. Ver [ADR-0001](https://github.com/TCC-Feedback-Analytics/feedback-analytics-api-gateway/blob/developer/docs/adr/0001-fonte-unica-de-schema.md).

## Checklist geral

- [ ] `npm run lint`, o typecheck e os testes passam (testes com Node 22.12 ou mais novo).
- [ ] Documentação atualizada quando aplicável.
