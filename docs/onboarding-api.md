# Guia do sistema: integração do frontend

O estado pertence ao usuário autenticado (cookie Better Auth), independentemente
de navegador/dispositivo. Não enviar userId ou enterpriseId. Nenhuma mudança no
frontend acompanha esta entrega. Não há migração de localStorage.

## Consultar

`GET /api/protected/user/onboarding/system-guide`

Resposta 200 (sem registro):

```json
{"tourKey":"system-guide","version":1,"status":"pending","finishedAt":null}
```

Os demais estados são `completed` e `skipped`; nesses casos `finishedAt` é uma
string ISO 8601 UTC gerada pelo servidor. As respostas usam `Cache-Control: no-store`.

## Concluir ou pular

`PUT /api/protected/user/onboarding/system-guide`

```json
{"version":1,"status":"completed"}
```

Para pular, enviar `status: "skipped"`. Usar a versão obtida no GET. O backend
aceita somente a versão atual; versões antigas/futuras e campos extras resultam
em 400. Não repetir uma gravação antiga com uma versão nova automaticamente.

Resposta 200: mesmo formato do GET, com o estado efetivamente persistido.
Requisições repetidas preservam a data; `skipped` pode evoluir para `completed`,
atualizando a data. `completed` nunca regride, inclusive entre abas concorrentes.

Erros: 400 `{"error":"invalid_payload"}`, 401 `{"error":"unauthorized"}`,
500 `{"error":"internal_error"}`. Em falhas de gravação, é seguro repetir o PUT.

## Comportamento esperado no frontend

- Remover leitura/escrita do localStorage do onboarding.
- Esperar o GET terminar com sucesso antes de decidir abrir automaticamente.
- Abrir automaticamente apenas com `pending` e contexto de IA preenchido.
- Manter a etapa atual em memória; separar ações de concluir e pular.
- Reabrir manualmente sem apagar o estado persistido (não existe reset remoto).
- Em falha de leitura, não tratar como pending nem bloquear o restante da aplicação.
- Em falha de escrita, informar que não foi salvo e permitir nova tentativa.
- Limpar estado/cache ao trocar de usuário e descartar respostas da sessão anterior.

O contexto obrigatório de IA continua derivado dos dados da empresa. Uma nova
versão do guia só deve ser publicada por decisão explícita de produto; incrementar
`SYSTEM_GUIDE_VERSION` torna o guia pendente para quem ainda não viu essa versão.

## Banco e implantação

O workflow [deploy-api.yml](../.github/workflows/deploy-api.yml) executa
`npm run db:migrate` automaticamente após gerar o bundle e antes de publicar a
API na Vercel. É necessário configurar o secret `DATABASE_URL` no GitHub com a
conexão do banco de produção. Se o secret estiver ausente ou a migration falhar,
a publicação é interrompida. A variável configurada apenas na Vercel não supre
esse secret do GitHub.

Em banco vazio, o comando aplica todas as migrations; nas próximas execuções,
aplica somente as pendentes conforme o histórico do Drizzle. Para desenvolvimento
local, executar `npm run db:migrate` com `DATABASE_URL` apontando para o banco local.
Migration do onboarding: `drizzle/0004_user_onboarding.sql` (com snapshot e journal).
A tabela tem PK `(user_id, tour_key, version)`, FK com exclusão em cascata,
validação de status e versão positiva. Ausência de linha significa pending.
O acesso é exclusivo pela API, com filtro por usuário da sessão.

Publicar o backend com sucesso antes de disponibilizar o frontend que consome
esses endpoints. O contrato de integração descrito acima permanece o mesmo.

Validação real opcional em banco local migrado:
`ONBOARDING_TEST_DATABASE_URL=postgresql://... npm test -- src/tests/onboarding.database.test.ts`
(no PowerShell, definir a variável via `$env:ONBOARDING_TEST_DATABASE_URL`).
O teste usa usuários temporários com UUIDs aleatórios e remove somente esses usuários.
