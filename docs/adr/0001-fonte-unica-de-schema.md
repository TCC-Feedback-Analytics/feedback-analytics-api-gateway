# ADR-0001: Fonte única de schema no Drizzle (schema.ts + migrations), com guard-rail interino contra drift pós-cutover Better Auth

**Status:** Proposto
**Data:** 2026-07-08
**Decisores:** Time do api-gateway (TCC)

## Contexto

O `feedback-analytics-api-gateway` mantém hoje **duas representações do mesmo schema de banco**, com origens e propósitos distintos, que divergiram após a migração de Supabase Auth para Better Auth (o "cutover"). Entender por que ambas existem é pré-requisito para a decisão.

**Representação 1 — `drizzle/` (fonte de migrations de produção + schema tipado que o app importa em runtime).**
- `drizzle.config.ts` aponta `schema: './drizzle/schema.ts'`, `out: './drizzle'`, dialeto `postgresql` e `schemaFilter: ['public']`. O próprio comentário do arquivo declara que `schemaFilter ['public']` é **crítico** para que `db:pull`/`db:generate`/`db:migrate` atuem apenas no schema `public` e **nunca** no schema `auth` (gerenciado pelo Supabase em produção).
- O fluxo é **database-first**: `drizzle/schema.ts` é *gerado* por introspecção do banco real via `npm run db:pull` (`drizzle-kit pull`), como documentado no código (`src/db/client.ts:15`, `src/db/types.ts:2-4`). É a origem histórica desta trilha — nasceu de um `db:pull` contra o Supabase.
- É também **dependência de runtime, e por isso não pode ser deletada**: `src/db/client.ts:16,42` faz `import * as schema` → `drizzle(sqlClient, { schema })`, e ~15 repositories/controllers, além de `src/db/tenantScope.ts`, `src/db/types.ts` e `scripts/verify-stats-drizzle.ts`, importam objetos de tabela de `../../drizzle/schema.js`.

**Representação 2 — `db/schema/*.sql` + `db/local/` (dumps SQL à mão que o `db:reset` aplica para montar o banco LOCAL).**
- São **mantidos à mão** (cabeçalhos em PT-BR `Descrição:`/`Uso:`, blocos `DO $$` idempotentes com guardas `pg_constraint`/`to_regclass`), copiados/adaptados do `database/sql/` do repo central para rodar em **Postgres puro** (`db/local/README.md:33-37`). Origem histórica: SQL adaptado a partir do modelo Supabase — `auth.users` mínima, `ARRAY → text[]`, e um shim (`db/local/00-shim.sql`) que recria `auth`/`auth.uid()`/roles `anon`/`authenticated` porque o local não sobe o Supabase.
- São consumidos **exclusivamente** por `scripts/db-local.mjs`, que é o que `npm run db:reset` roda (grep exaustivo confirma nenhum outro consumidor). É infraestrutura de conveniência do ambiente local. Já refletem o estado **pós-cutover**: tabelas Better Auth (`db/schema/tables/public.better_auth.sql`), FK `enterprise.auth_user_id → public.user`, view `enterprise_public` com duplo `LEFT JOIN`.

**Existe ainda uma terceira trilha, de produção:** `db/cutover/*.sql` — SQL **manual**, aplicado à mão **fora do CI** (`deploy-api.yml` não roda migration). O banco real de produção = `drizzle/0000_bumpy_the_order.sql` (baseline, marcado como aplicado à mão uma vez) + `betterauth-enable.sql` + (opcional) `betterauth-finalize.sql` + `enterprise-user-fk.sql`.

**O problema concreto de drift.** Como o cutover foi SQL manual fora do fluxo Drizzle, `drizzle/schema.ts` está **congelado no estado pré-cutover** e diverge do banco real em três eixos, divergência já reconhecida em `docs/migrations-drizzle.md:72`:

- **FK de `enterprise.auth_user_id`**: `schema.ts:187-191` ainda aponta para `auth.users` do Supabase (`usersInAuth.id`, `import { authUsers } from 'drizzle-orm/supabase'`) com `onDelete('cascade')`; o banco real aponta para `public.user` do Better Auth (`db/cutover/enterprise-user-fk.sql`).
- **13 conjuntos de policies RLS `auth.uid()`**: declaradas no baseline e em `schema.ts`; **dropadas** em produção por `db/cutover/betterauth-enable.sql:96-118`.
- **4 tabelas core do Better Auth** (`user`/`session`/`account`/`verification`): **ausentes** de `drizzle/` (grep = zero matches); presentes no banco real, em `db/schema/tables/public.better_auth.sql` e em `src/auth/schema.ts` — este último é o schema que o `drizzleAdapter` do Better Auth usa, fora do alcance do `drizzle-kit`.

O gatilho recente que materializou o custo do drift: a **FK de cascade `enterprise.auth_user_id → public.user ON DELETE CASCADE`** (commit `eb2f3b9`) teve que ser escrita à mão em **dois lugares** — o dump local (`db/schema/tables/public.enterprise.sql:104-121`) e o script manual de produção (`db/cutover/enterprise-user-fk.sql:37-74`) — enquanto `drizzle/schema.ts`, a "fonte da verdade", **não foi atualizado** e segue com a FK antiga → `auth.users`. Qualquer próxima mudança estrutural precisa ser espelhada em até três lugares; esquecer um deles gera divergência **silenciosa** entre local, produção e "fonte da verdade".

**Restrições que enquadram a decisão:**
- Um `db:pull` ingênuo hoje **quebra o baseline**: `docs/migrations-drizzle.md:73` já relata que o pull com `schemaFilter: ['public']` gerou baseline inconsistente que queria **criar** `auth.users`; e `schema.ts:3-9` avisa que as duas linhas do `authUsers` precisam ser reaplicadas à mão após cada pull.
- **RLS não é o mecanismo de isolamento** em runtime: o app conecta como role que ignora RLS (superuser); multi-tenant é por filtro explícito de `enterprise_id` no `tenantScope` (`src/db/client.ts:8-11`). O drift de policies é dívida de *paridade/documentação*, não de segurança em runtime.
- **Dependências residuais de `auth` sobrevivem em prod pós-cutover**: `tracked_devices.blocked_by → auth.users` (FK nunca tocada por nenhum script de cutover), a view `enterprise_public` (`LEFT JOIN auth.users` de fallback) e funções legadas (`create_enterprise_on_signup`, `phone_exists`, `jwt_custom_claims`) que ainda tocam `auth.users`/`auth.uid()`.
- **`drizzle-kit` não gera nem versiona corpos de função plpgsql, triggers nem policies**: as 11 funções vivem como SQL curado em `db/schema/functions/`, e os 13 `CREATE TRIGGER` (11× `set_updated_at` mais os 2 de validação `validate_questions_of_feedbacks_context`/`validate_feedback_insights_report_context`) ficam nos dumps de `db/schema/tables/` — estes dois últimos com funções-trigger declaradas inline no próprio dump.

## Decisão

Adotar **`drizzle/schema.ts` + migrations Drizzle versionadas como fonte única de verdade do schema** (o *alvo*), e **eliminar `db/schema/*.sql` como representação paralela mantida à mão**.

A justificativa é assimétrica e decisiva: **o app já depende de `drizzle/schema.ts` em runtime** (`src/db/client.ts` + ~15 arquivos). Esse objeto **tem** de existir e **tem** de estar correto, independentemente de qualquer decisão de tooling. Já `db/schema/*.sql` tem um único consumidor (`scripts/db-local.mjs`) e é substituível por `drizzle-kit migrate` sem tocar em uma linha de código de aplicação. A pergunta não é "qual das duas manter", e sim "qual é redundante" — e a resposta cai naturalmente sobre `db/schema/`.

Como o re-baseline pleno é caro e arriscado num contexto de TCC com prazo (o próprio `db:pull` já falhou uma vez), a decisão é executada em **duas fases**, com um **guard-rail interino** que torna o drift visível e barato de conter até a consolidação:

**Fase 1 — Guard-rail interino (ponte, não destino).**
1. Declarar, neste ADR e numa nota no topo de `drizzle/schema.ts` e em `docs/migrations-drizzle.md`, que `schema.ts` está **congelado pré-cutover**, listando os 3 drifts conhecidos e as 2 dependências `auth` remanescentes.
2. **Teste de CI anti-drift**: subir um Postgres efêmero, rodar `npm run db:reset`, comparar o schema resultante com as migrations Drizzle (via `drizzle-kit`), e **falhar em qualquer divergência fora de uma allowlist** dos drifts já conhecidos e aceitos. Drift **novo** quebra o build; drift **conhecido** fica registrado por escrito.

**Fase 2 — Consolidação na fonte única (o alvo).**
3. Reconciliar `drizzle/schema.ts` com o estado real pós-cutover (FK → `public.user`, remover as policies `auth.uid()` legadas, incorporar as tabelas Better Auth via `src/auth/schema.ts`, view com duplo `LEFT JOIN`), **preferindo reconciliação explícita a `db:pull` cego** — o pull passa a servir só como diff/auditoria contra um `schema.ts` já reconciliado.
4. **Funções, triggers, view e RLS viram migrations SQL versionadas** dentro de `drizzle/` (arquivos `.sql`, entradas no `_journal.json`). O que o `drizzle-kit generate` não modela nativamente entra como migration SQL escrita à mão, porém versionada e sequenciada pelo mesmo journal.
5. `db:reset` deixa de aplicar `db/schema/` e passa a rodar **`drizzle-kit migrate` + `db:seed:e2e`**, fazendo o local exercitar as mesmas migrations da produção.
6. O shim local (`db/local/00-shim.sql`) é **preservado** como camada de portabilidade Postgres-puro (não é schema de negócio, é adaptador de ambiente) e permanece fora da fonte única.

## Opções consideradas

### Opção A — Status quo (manter as duas/três representações, espelhar à mão)

| Dimensão | Avaliação |
|---|---|
| Complexidade | Baixa por mudança isolada, **crescente** — cada alteração estrutural exige espelhar em `drizzle/`, `db/schema/` e `db/cutover/` |
| Esforço/Custo | Zero imediato; **imposto recorrente** a cada mudança, propenso a erro humano |
| Risco de drift | **Alto e já materializado** — a FK de cascade recente foi escrita em 2 lugares e nunca no `drizzle/`; `schema.ts` diverge do banco real em FK, 13 policies e 4 tabelas |
| Familiaridade do time | Alta (é o hoje), mas depende de conhecimento tácito de "onde mais mexer" |

**Prós:** nenhum esforço agora; nada quebra hoje.
**Contras:** perpetua drift **silencioso**; esquecer o cutover manual **ou** o Drizzle gera divergência que só aparece em runtime; indefensável como decisão consciente de engenharia num TCC.

### Opção B — Fonte única no Drizzle (schema.ts + migrations) [RECOMENDADA]

| Dimensão | Avaliação |
|---|---|
| Complexidade | Média no re-baseline (reconciliar `schema.ts` + portar funções/triggers/view/RLS para migrations); **baixa em regime permanente** — um único fluxo, o padrão do Drizzle |
| Esforço/Custo | Concentrado e único; depois, custo marginal por mudança cai a **1 lugar** |
| Risco de drift | **Baixo** — some a categoria "espelhar em 3 lugares"; local e prod passam a rodar as mesmas migrations |
| Familiaridade do time | Alta — é o workflow oficial do Drizzle, já parcialmente em uso (`db:generate`/`db:migrate`; `0001` é deste fluxo) |

**Prós:** elimina a representação redundante (`db/schema/`) sem tocar no que o runtime importa; alinha local e prod à mesma sequência de migrations; formaliza o cutover manual dentro do versionamento; encerra o débito reconhecido em `docs/migrations-drizzle.md:72`.
**Contras:** re-baseline exige cuidado com `schemaFilter: ['public']` (um `db:pull` cego quer *criar* `auth.users`); funções/triggers/RLS precisam ser mantidas como SQL manual dentro de migrations (o `generate` não as deriva); é o esforço mais alto entre as opções — por isso a execução é faseada, com o guard-rail (Opção D) como ponte.

### Opção C — Gerar `db/schema/` por introspecção/auto-dump (manter o artefato legível, mas não editado à mão)

| Dimensão | Avaliação |
|---|---|
| Complexidade | Média-alta — construir um pipeline que *gere* os dumps `db/schema/*.sql` a partir do banco/migrations, em vez de editá-los à mão |
| Esforço/Custo | Alto de setup e **recorrente** — dois artefatos derivados (o `schema.ts` do ORM e os dumps SQL) que precisam ser regenerados a cada mudança |
| Risco de drift | Médio — reduz o drift *manual*, mas mantém **duas** representações que podem dessincronizar se a geração não rodar |
| Familiaridade do time | Baixa — inexistente hoje; exige inventar e manter um gerador de dumps |

**Prós:** preserva um artefato SQL legível e portável (auth.users mínima, `ARRAY→text[]`, shim) útil para o ambiente Postgres-puro; remove a edição manual como fonte de erro.
**Contras:** não elimina a duplicação, só a automatiza; adiciona um pipeline a manter; ainda exige que a fonte real seja o Drizzle (o runtime importa `schema.ts`), logo `db/schema/` continua sendo derivado secundário — ganho pequeno frente ao custo.

### Opção D — Guard-rail interino apenas (ponte, não destino)

| Dimensão | Avaliação |
|---|---|
| Complexidade | Baixa — um teste de CI (Postgres efêmero + `db:reset` + `drizzle-kit` + diff contra allowlist) e notas de documentação; nada toca runtime nem produção |
| Esforço/Custo | Baixo (~0,5–1 dia); reaproveita `scripts/db-local.mjs` e o `drizzle-kit` já configurados |
| Risco de drift | Médio→controlado — não elimina as trilhas, mas **converte drift silencioso em falha de CI**; o restante fica conhecido, listado e aceito por escrito |
| Familiaridade do time | Alta — usa ferramentas já no projeto |

**Prós:** compatível com o prazo do TCC; entrega valor imediato contra o "sangramento silencioso"; reversível e incremental; rende narrativa de defesa ("identifiquei, contive e agendei a resolução").
**Contras:** **não é destino** — a dívida das duas/três trilhas continua viva; mudança de schema ainda custa múltiplas edições; exige disciplina para manter a allowlist honesta (um drift aceito por preguiça enfraquece o guard-rail).

## Análise de trade-offs

O critério decisivo é **onde o acoplamento é irremovível**. O runtime importa `drizzle/schema.ts` diretamente: esse objeto é obrigatório e precisa estar correto. `db/schema/*.sql` serve só ao `db:reset` local e é substituível por `drizzle-kit migrate` sem tocar código de aplicação. Manter as duas representações significa manter, para sempre, um objeto obrigatório (`schema.ts`) *e* um objeto opcional que duplica sua informação (`db/schema/`), com sincronização 100% manual. Por isso a **Opção B** (remover o opcional) é o alvo, a **Opção A** (manter ambos) é o custo de espelhamento perpétuo, e a **Opção C** apenas automatiza a duplicação sem eliminá-la.

O maior contra-argumento à Opção B — "o Drizzle não modela funções/triggers/RLS" — não desempata a favor de manter `db/schema/`: essas funções, triggers, view e policies **já são SQL escrito à mão hoje**; a Opção B apenas as move para dentro do diretório de migrations versionadas (entrada no `_journal.json`, ordem determinística), trocando o aplicador caseiro (`TABLE_ORDER`/2-passes do `db-local.mjs`) por um aplicador padronizado, sem perder expressividade SQL. E o `schemaFilter: ['public']` é facilitador, não obstáculo: como o banco pós-cutover não tem mais a FK para `auth.users` e as tabelas Better Auth vivem em `public`, a única armadilha (o pull querer recriar `auth.users`) é contornável com reconciliação explícita e mantendo o shim fora da fonte única — trabalho pontual, não recorrente.

O que justifica **não** fazer a Opção B de uma vez, e sim atravessá-la pela **Opção D** primeiro, é o eixo **prazo/risco de TCC**. O re-baseline concentra alto esforço e risco num terreno reconhecidamente escorregadio, e há evidência concreta de que o `db:pull` já falhou (`migrations-drizzle.md:73`), além de o `drizzle-kit` não regenerar fielmente os corpos das funções que são o coração da lógica anti-fraude (`register_device_feedback`, `can_device_send_feedback`) e de provisionamento (`create_enterprise_on_signup`). Perder ou corromper essas definições é o pior cenário. A Opção D custa pouco, torna o drift **visível** (o incidente que motivou este ADR nasceu de espelhamento manual esquecido) e preserva tempo para produto/escrita — mas é **ponte, não destino**: sozinha, mantém a dívida viva. Daí a decisão faseada: D contém agora, B resolve depois.

Nota de severidade: o drift de RLS é de baixo risco funcional (runtime ignora RLS; isolamento é por `tenantScope`), o que reforça que a urgência imediata é de *contenção/documentação*, não de correção. Já a dependência residual de `auth.users` na view `enterprise_public` (que roda como owner, `security_invoker=off`, para o fluxo anônimo e lê `raw_user_meta_data`) merece atenção específica na Fase 2, pois enquanto `auth.users` sobreviver como tabela fantasma em prod, dado órfão ali pode ser exposto pela view anônima.

## Consequências

**Fica mais fácil:**
- Detectar drift **novo** já na Fase 1: qualquer divergência entre `db:reset` (local) e as migrations Drizzle quebra o CI antes do merge.
- Ao fim da Fase 2, uma mudança estrutural passa a exigir **1 lugar** (uma migration Drizzle), não 3; local e produção rodam a **mesma sequência de migrations**.
- O `schema.ts` que o runtime importa passa a **corresponder ao banco real** (FK → `public.user`, sem policies legadas, com tabelas Better Auth), fechando o drift de FK/RLS/tabelas e tornando `db:pull` utilizável de novo como auditoria.
- Onboarding e TCC ganham narrativa única: "database-first Drizzle, migrations versionadas", com o débito documentado e contido em vez de silencioso.

**Fica mais difícil / exige disciplina:**
- Na Fase 1, surge a obrigação de manter a **allowlist** do teste de CI honesta e enxuta; cada exceção precisa de justificativa e link para este ADR. O job adiciona tempo de pipeline (Postgres efêmero + `db:reset`).
- Até a Fase 2, mudança estrutural continua exigindo espelhar em até três lugares.
- Na Fase 2, funções plpgsql, triggers, view `enterprise_public` e RLS precisam ser mantidas como **migrations SQL manuais** dentro de `drizzle/` (o `generate` não as deriva). Produção deixa de aceitar SQL "por fora": o cutover manual precisa ser absorvido como migration, e futuros cutovers devem passar por `generate → migrate`.
- Incorporar `src/auth/schema.ts` ao alcance do `drizzle-kit` muda a topologia de `drizzle.config.ts` (hoje `schema` único) e precisa preservar `generateId:false`/UUIDs migrados de `auth.users.id`.

**O que revisitar:**
- **Gatilhos da Fase 2:** após a entrega/defesa do TCC; se a allowlist de drift crescer (sinal de que o interino virou permanente); ou se surgir uma mudança de schema grande (quando o re-baseline sai mais barato que espelhar em três lugares).
- **Dependências residuais de `auth`:** destino de `tracked_devices.blocked_by → auth.users` (FK nunca tocada) e do fallback `LEFT JOIN auth.users` na view; decidir se `auth.users` legado permanece em prod ou é dropado após migrar `blocked_by`, funções e view. Enquanto não migrada, `usersInAuth` **precisa** continuar em `schema.ts` — remoção prematura quebra a FK.
- **Governança das tabelas Better Auth:** confirmar o mecanismo real de migração em prod (não há `auth:migrate` em `package.json`; provável `@better-auth/cli` ou SQL manual — não verificado) e decidir se passam a ser geridas via `drizzle.config` ou pelo Better Auth CLI com o Drizzle só as descrevendo — evitar dois donos da mesma DDL.
- **Baseline e CI:** se `drizzle/0000_bumpy_the_order.sql` for reescrito, reavaliar a marcação manual do baseline para prod não reaplicá-lo; decidir se `deploy-api.yml` passa a rodar `drizzle-kit migrate`, encerrando a aplicação manual fora do CI.
- **`drizzle/relations.ts`** não é importado por nada em `src/` — avaliar remoção.

## Itens de ação

**Fase 1 — Guard-rail interino (agora):**
- [ ] Adicionar este ADR ao repo e preencher a data.
- [ ] Escrever a nota de "fonte da verdade congelada pré-cutover" no topo de `drizzle/schema.ts` e em `docs/migrations-drizzle.md`, listando os 3 drifts (FK `enterprise`, 13 policies `auth.uid()`, 4 tabelas Better Auth) e as 2 dependências `auth` remanescentes (`tracked_devices.blocked_by`, view `enterprise_public`).
- [ ] Criar um checklist de "mudança de schema" (espelhar em `drizzle/`, `db/schema/`, `db/cutover/` + reaplicar as 2 linhas de `authUsers` após qualquer `db:pull`) e referenciá-lo no template de PR.
- [ ] Implementar o **teste de CI anti-drift**: workflow que (a) sobe Postgres efêmero, (b) roda `npm run db:reset`, (c) roda `drizzle-kit` em modo de checagem/introspecção contra esse banco, (d) compara com uma **allowlist** versionada dos drifts conhecidos e **falha** em qualquer diferença fora dela.
- [ ] Versionar a allowlist (cada drift com justificativa e link para este ADR) e validar num PR de teste que drift **novo** quebra o build e drift **conhecido** passa.
- [ ] Documentar/verificar o mecanismo real de migração das tabelas Better Auth em produção e incorporá-lo ao checklist/CI.
- [ ] Abrir tarefa "Fase 2 — consolidação na fonte única", com os gatilhos de revisão desta decisão.

**Fase 2 — Consolidação na fonte única (pós-entrega/defesa):**
- [ ] Fazer `pg_dump` completo de produção **pós-cutover** e tag git de partida (ponto de reversão) antes de qualquer introspecção.
- [ ] Mapear formalmente o delta entre `drizzle/schema.ts` e o banco real (FK `enterprise`, 13 policies dropadas, 4 tabelas Better Auth, view, `blocked_by`), consolidando `docs/migrations-drizzle.md:72`.
- [ ] Incorporar as **tabelas Better Auth** (`src/auth/schema.ts`: `user`/`session`/`account`/`verification`) ao alcance do `drizzle-kit`, preservando `id uuid`/`generateId:false`; validar que o ORM continua importável em runtime.
- [ ] Reconciliar `drizzle/schema.ts` ao estado pós-cutover (FK `enterprise.auth_user_id → public.user ON DELETE CASCADE`; remover as 13 policies `auth.uid()`; view `enterprise_public` com duplo `LEFT JOIN`), **preferindo reconciliação explícita a `db:pull` cego**; manter `usersInAuth` apenas enquanto `tracked_devices.blocked_by` depender de `auth.users`.
- [ ] Portar as **11 funções** (triggers: `update_updated_at_column`, `clean_user_metadata_before_change`, `create_enterprise_on_signup`; RPCs plpgsql: `generate_device_fingerprint`, `register_device_feedback`, `can_device_send_feedback`; sql: `document_exists`, `phone_exists`, `enterprise_public_documents_fn`, `enterprise_public_ids_fn`, `jwt_custom_claims`), os **13 triggers** (11× `set_updated_at` + `validate_questions_of_feedbacks_context` + `validate_feedback_insights_report_context`, os dois últimos com funções-trigger inline nos dumps de tabela), a **view** e as **policies RLS** desejadas para **migrations SQL versionadas** em `drizzle/` (decidir se RLS entra como paridade/defesa em profundidade, dado que o runtime a ignora por design).
- [ ] Absorver `db/cutover/*.sql` (`betterauth-enable`, `betterauth-finalize`, `enterprise-user-fk`) como migration(s) de reconciliação **idempotentes** (`IF EXISTS`/`IF NOT EXISTS`/`to_regclass`/loop em `pg_constraint`), no-op em prod e construtivas em ambiente limpo; marcar `db/cutover/` como histórico.
- [ ] Reescrever `npm run db:reset` para **`drizzle-kit migrate` + `npm run db:seed:e2e`**, removendo a orquestração `TABLE_ORDER`/2-passes de `scripts/db-local.mjs`.
- [ ] **Preservar `db/local/00-shim.sql`** como pré-passo do reset local (schema `auth`, `auth.uid()` via `app.current_user_id`, roles `anon`/`authenticated`), fora da fonte única e documentado como adaptador Postgres-puro.
- [ ] Tratar as **dependências residuais de `auth`** como migrations separadas e reversíveis: migrar `tracked_devices.blocked_by → public.user` (padrão `NOT VALID` + `VALIDATE` se 0 órfãs) e só então remover `usersInAuth` de `schema.ts`; portar `create_enterprise_on_signup`/`phone_exists`/`jwt_custom_claims` para `public.user` (ou desativar `jwt_custom_claims` se sem consumidor JWT); avaliar dropar `auth.users` fantasma de prod, fechando a superfície anônima da view.
- [ ] Validar end-to-end: `db:reset` local reproduz o schema de prod; `npm run build`/testes e `scripts/verify-stats-drizzle.ts` passam; `db:pull` usado **apenas para diff** confirma zero divergência (sem tentativa de criar `auth.users`).
- [ ] **Deprecar e remover `db/schema/*.sql`** e a orquestração associada em `scripts/db-local.mjs` após o novo `db:reset` estar verde; avaliar remover `drizzle/relations.ts` (sem consumidores).
- [ ] Reavaliar a marcação de baseline (`drizzle/0000_bumpy_the_order.sql`) para prod não reaplicá-lo; decidir se `deploy-api.yml` passa a rodar `drizzle-kit migrate`.
- [ ] Atualizar `docs/migrations-drizzle.md`, `db/local/README.md` e `db/cutover/README.md` para descrever a fonte única e remover a nota de "reconciliação pendente".
