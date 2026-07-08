# Plano de execução — Fase 2 do ADR-0001 (re-baseline para fonte única)

> Companheiro do [ADR-0001](0001-fonte-unica-de-schema.md). O ADR **decide** consolidar
> o schema em `drizzle/schema.ts` + migrations; este documento é o **runbook** passo a
> passo do re-baseline. Não executar antes dos gatilhos da Fase 2 (pós-entrega/defesa do
> TCC, ou allowlist de drift crescendo, ou mudança de schema grande à vista).

## Princípios

- **Reversível por passo.** Cada passo termina num estado buildável e testável; o rollback é reverter o commit/branch.
- **Ponto de partida imutável.** `pg_dump` + tag git antes de tocar em qualquer coisa.
- **Reconciliação explícita > `db:pull` cego.** O pull passa a servir só como *diff/auditoria* — nunca sobrescrever `schema.ts` no automático (o pull ingênuo já falhou uma vez querendo recriar `auth.users`, ver `docs/migrations-drizzle.md`).
- **Nada destrutivo em produção sem backup e sem passo reversível.** Toda mudança em prod é migration idempotente.
- **Gate por passo.** Só avança quando o critério de validação do passo passa.
- **Pré-condição:** o guard-rail da Fase 1 (`schema-drift`) está verde e a janela de "congelamento de schema" está combinada com o time.

---

## Passo 0 — Preparação e ponto de reversão

1. Combinar uma **janela de congelamento** de mudanças de schema (nada de `db/cutover` novo no meio).
2. **Backup de produção:** `pg_dump` completo (com dados) e um `pg_dump --schema-only` separado — guardar como artefato.
3. **Tag git de partida** (`git tag pre-fase2-rebaseline`) e branch dedicada (`chore/fase2-fonte-unica`).
4. Registrar no PR inicial o link para o ADR e a lista de gates.

**Gate 0:** backup restaurável validado num banco descartável; tag criada.

---

## Passo 1 — Fotografar o estado real de produção (o "alvo")

1. Contra o Postgres de produção (pós-cutover): `pg_dump --schema=public --schema-only --no-owner --no-privileges` → normalizar (reusar `scripts/schema-drift.mjs` como referência de normalização).
2. Esse dump é o **alvo canônico**: é o que `drizzle/schema.ts` + migrations precisam reproduzir ao final.
3. Fazer o mesmo contra o banco **local** (`db:reset` atual) e **diffar** os dois → mapeia formalmente o delta local×prod (deve bater com os drifts conhecidos: FK, 13 policies, tabelas Better Auth).

**Gate 1:** o delta local×prod é **exatamente** o esperado (sem surpresas fora dos 3 drifts + deps residuais).

---

## Passo 2 — Trazer as tabelas Better Auth para o alcance do Drizzle

Decisão de **governança** a tomar aqui (documentar no PR): quem é dono da DDL de `user`/`session`/`account`/`verification`?
- **Opção recomendada:** o Drizzle **descreve** (as tabelas entram no alcance do `drizzle-kit`) e as **migrations** as criam; o Better Auth apenas as consome via `drizzleAdapter`. Evita "dois donos" da mesma DDL.
- Alternativa: manter o `@better-auth/cli` como dono e o Drizzle só referenciando — mais frágil (duas ferramentas).

Passos:
1. Apontar `drizzle.config.ts` para **os dois** schemas: `schema: ['./drizzle/schema.ts', './src/auth/schema.ts']` (o drizzle-kit aceita array), **ou** mover as definições de `src/auth/schema.ts` para dentro de `drizzle/schema.ts` (fonte única literal). Preservar `id uuid`/`generateId:false` e os UUIDs migrados.
2. `npm run db:generate` → primeira migration que cria `user/session/account/verification` (ou reconhece que já existem — ajustar para idempotência).
3. Validar que o app continua importando o schema em runtime (`src/db/client.ts` + repositories).

**Gate 2:** `npm run build`/`tsc` verdes; `getAuth()` e as queries tipadas continuam funcionando; a migration cria as 4 tabelas num banco limpo.

---

## Passo 3 — Reconciliar `drizzle/schema.ts` ao estado pós-cutover

Editar **à mão** (reconciliação explícita), no `drizzle/schema.ts`:
1. **FK `enterprise.auth_user_id`**: trocar o alvo `usersInAuth.id` (auth.users) por `user.id` (Better Auth), com `onDelete('cascade')`.
2. **Policies RLS `auth.uid()`**: decidir — **(a)** remover as 13 (paridade com prod, que as dropou) ou **(b)** mantê-las como defesa em profundidade **apontando para `public.user`**. Recomendação: manter uma versão saneada (defesa em profundidade), já que o runtime ignora RLS mas ela é rede de segurança; decidir e documentar.
3. **View `enterprise_public`**: refletir o duplo `LEFT JOIN` (`public.user` + fallback `auth.users`).
4. **`usersInAuth`**: manter **apenas** enquanto `tracked_devices.blocked_by` ainda depender de `auth.users` (removido no Passo 7).
5. Rodar `npm run db:pull` **apenas para diff/auditoria** contra o `schema.ts` já reconciliado — não aceitar sobrescrita cega.

**Gate 3:** o `db:pull` de auditoria não acusa divergência estrutural (e **não** tenta criar `auth.users`); `db:generate` produz uma migration coerente com o delta do Passo 1.

---

## Passo 4 — Portar funções, triggers, view e RLS para migrations SQL versionadas

O `drizzle-kit generate` **não** deriva corpos de função plpgsql, triggers nem policies — então entram como **migration SQL escrita à mão, porém versionada**:
1. `npx drizzle-kit generate --custom` → cria uma migration `.sql` vazia + entrada no `meta/_journal.json`.
2. Copiar para ela, de forma **idempotente**: as **11 funções** (`CREATE OR REPLACE FUNCTION`), os **13 triggers** (`DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`: 11× `set_updated_at` + `validate_questions_of_feedbacks_context` + `validate_feedback_insights_report_context`), a **view** e as **policies** desejadas.
3. Ajustar tudo que hoje aponta para `auth.users`/`auth.uid()` para `public.user` quando aplicável (ex.: `create_enterprise_on_signup`) — ou deixar explicitamente marcado para o Passo 7.

**Gate 4:** aplicar as migrations num banco **limpo** recria todas as 11 funções + 13 triggers + view + policies; `scripts/verify-stats-drizzle.ts` passa.

---

## Passo 5 — Absorver `db/cutover/*.sql` como migration(s) de reconciliação

1. Transformar `betterauth-enable.sql`, `betterauth-finalize.sql` e `enterprise-user-fk.sql` em **uma migration idempotente** (`IF EXISTS`/`IF NOT EXISTS`/`to_regclass`/loop em `pg_constraint`): **no-op** contra a produção já migrada, **construtiva** num banco limpo.
2. Marcar `db/cutover/` como **histórico** (README apontando para as migrations que os substituíram).

**Gate 5:** a migration roda **duas vezes** seguidas sem erro (idempotência), tanto em banco limpo quanto num snapshot de prod.

---

## Passo 6 — Reescrever o `db:reset` (local = mesmas migrations da prod)

1. Novo `db:reset` = **`db/local/00-shim.sql`** (pré-passo de portabilidade) → **`drizzle-kit migrate`** → **`npm run db:seed:e2e`**.
2. **Preservar o shim** (`auth` schema, `auth.uid()` via `app.current_user_id`, roles `anon`/`authenticated`) como adaptador Postgres-puro, **fora** da fonte única e documentado como tal.
3. Remover a orquestração `TABLE_ORDER`/2-passes de `scripts/db-local.mjs`.

**Gate 6:** `db:reset` local, dumpado e normalizado, **reproduz o alvo do Passo 1** (schema de prod); testes de integração/e2e passam contra o banco local reconstruído.

---

## Passo 7 — Dependências residuais de `auth` (migrations separadas e reversíveis)

1. **`tracked_devices.blocked_by → public.user`**: migration com o padrão já usado na FK de `enterprise` (`NOT VALID` + `VALIDATE` se 0 órfãos; senão, listar e limpar).
2. Portar `create_enterprise_on_signup`, `phone_exists`, `jwt_custom_claims` para `public.user` — ou **desativar `jwt_custom_claims`** se confirmado que não há consumidor JWT (o gateway usa sessão por cookie).
3. Só **depois** disso, remover `usersInAuth`/`import authUsers` de `drizzle/schema.ts`.
4. Avaliar **dropar `auth.users` fantasma** de produção — isso fecha a superfície anônima da view `enterprise_public` (que roda como owner, `security_invoker=off`, e lia `raw_user_meta_data`). Fazer só após 1–3 e com backup.

**Gate 7:** nenhuma referência a `auth.users`/`auth.uid()` resta no schema/funções (grep limpo); a view `enterprise_public` serve só de `public.user`; app e testes verdes.

---

## Passo 8 — Baseline e deploy

1. Reavaliar `drizzle/0000_bumpy_the_order.sql`: como o schema real mudou, decidir entre **reescrever o baseline** (novo `0000` do estado atual) ou mantê-lo marcado-como-aplicado e empilhar as migrations novas. Recalcular a marcação manual de baseline em prod se reescrito.
2. Decidir se **`deploy-api.yml` passa a rodar `drizzle-kit migrate`** no deploy — encerrando a aplicação de SQL manual fora do CI (fim do modelo `db/cutover` manual).

**Gate 8:** um deploy de teste (staging/homolog) aplica as migrations de forma limpa e idempotente.

---

## Passo 9 — Remoção, limpeza e docs

1. **Deprecar e remover `db/schema/*.sql`** e a orquestração associada em `scripts/db-local.mjs`.
2. **Aposentar o guard-rail golden** (`db/schema/.drift-snapshot.sql` + `scripts/schema-drift.mjs` + workflow `schema-drift`): com fonte única, o drift entre representações deixa de existir; substituir, se quiser, por um check `drizzle-kit` de "migrations aplicadas == schema.ts".
3. Avaliar remover `drizzle/relations.ts` (sem consumidores em `src/`).
4. Atualizar `docs/migrations-drizzle.md`, `db/local/README.md`, `db/cutover/README.md` e o **banner de "fonte congelada"** no topo de `drizzle/schema.ts` (que deixa de valer).
5. Marcar o **status do ADR-0001 como `Aceito`** (e os itens da Fase 2 concluídos).

**Gate 9:** repositório sem a representação `db/schema/`; CI verde; docs coerentes.

---

## Agrupamento sugerido em PRs

| PR | Passos | Entrega |
|---|---|---|
| PR-1 | 0–3 | Backup/tag, delta mapeado, tabelas Better Auth no Drizzle, `schema.ts` reconciliado |
| PR-2 | 4–5 | Funções/triggers/view/RLS + cutover como migrations idempotentes |
| PR-3 | 6 | `db:reset` = shim + `drizzle-kit migrate` + seed; local reproduz prod |
| PR-4 | 7 | Dependências residuais de `auth` migradas; `usersInAuth` removido |
| PR-5 | 8–9 | Baseline/deploy decididos; `db/schema/` e guard-rail removidos; docs; ADR `Aceito` |

## Rollback global

Qualquer PR pode ser revertido isoladamente (branch/commit). O ponto de não-retorno é o **Passo 7.4** (dropar `auth.users` de prod) — fazer por último, com backup fresco e depois de 8 validado. Até lá, tudo é reversível por `git revert` + re-deploy do commit anterior (o mesmo modelo de rollback do cutover atual).
