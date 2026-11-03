# Backend — Referência de Endpoints

> **Base URL (desenvolvimento):** `http://localhost:3000`

Todos os endpoints protegidos usam a sessão que trafega por **cookies HttpOnly** (gerenciada pelo Better Auth). O cliente deve enviar as requisições com `credentials: 'include'`. **Não** há header `Authorization: Bearer`.

> **Nota:** todas as rotas são prefixadas com `/api` (ex.: `GET /api/health`).

---

## Health

### `GET /api/health`

Verifica se o serviço está operacional. Use para confirmar que o Gateway está rodando antes de fazer outras chamadas.

```bash
curl http://localhost:3000/api/health
```

**Response 200**
```json
{ "ok": true }
```

---

## Usuário (Conta)

### `GET /api/protected/user/auth_user`

Retorna o usuário autenticado, extraído da sessão (injetado por `requireAuth`).

**Response 200**
```json
{ "user": { "id": "uuid", "email": "gestor@empresa.com", "phone": "+5511999990000", "user_metadata": { "full_name": "Maria" } } }
```

> `phone` está sempre presente (valor ou `null`).

---

### `PATCH /api/protected/user/email`

Inicia a troca de e-mail pelo `changeEmail` do Better Auth, com retorno para `<web>/auth/success`. O link do e-mail passa pelo `/api/auth/verify-email` do Better Auth, não pelo `GET /public/auth/callback`.

> **Hoje a troca não acontece:** `user.changeEmail.enabled` não está ligado em `src/auth/auth.ts`, então o Better Auth recusa o pedido e a rota responde `400 update_failed`.

**Body**
```json
{ "email": "novo@empresa.com" }
```

**Response 200** — devolve o e-mail pedido, antes da confirmação.
```json
{ "user": { "id": "uuid", "email": "novo@empresa.com" } }
```

**Response 400** `invalid_payload` / `update_failed`.

---

### `PATCH /api/protected/user/metadados`

Atualiza metadados do usuário. Hoje só o `full_name`, que vai para `user.name`.

**Body**
```json
{ "full_name": "Maria" }
```

`full_name` é obrigatório, de 2 a 120 caracteres.

**Response 200**
```json
{ "user": { "id": "uuid", "email": "gestor@empresa.com", "user_metadata": { "full_name": "Maria" } } }
```

**Response 400** `invalid_payload` — body fora do schema. *(O `UPDATE` no banco não tem tratamento de erro próprio; este endpoint não emite `update_failed`.)*

---

### `POST /api/protected/user/complete-signup`

**Primeira entrada com o Google.** A entrada passa pelo handler nativo do Better Auth: `POST /api/auth/sign-in/social` com `{ provider: "google", callbackURL, errorCallbackURL }` e, na volta, `/api/auth/callback/google`.

O Google dá o nome da pessoa e o e-mail, que já vem verificado. Ao criar a conta, a empresa já é criada (hook `account.create.after`), sem os termos. Esta rota completa o que falta.

**Body:**
```json
{ "fullName": "Padaria Bom Pão", "phone": "+5511987654321", "terms": true }
```

- `fullName` é o nome do negócio (2 a 160 caracteres) e vai para `user.name`; `phone` (formato `+55DDXXXXXXXXX`) vai para `user.phone`; `terms` precisa ser `true`. Campos extras são recusados.
- O aceite (`terms_version: v1` e a data) vai para a empresa. A empresa também é criada aqui, se ainda não existir.
- **Respostas:**
  - `200 { ok: true }`;
  - `400 invalid_payload`;
  - `409 phone_taken`: o telefone é de outra conta;
  - `500 internal_server_error`.
- **Mesmo e-mail com senha e com Google = a mesma conta** (`accountLinking` com o Google como provedor confiável).
- **Ligar e desligar:** o Google só funciona com `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` no ambiente.

---

### `POST /api/protected/user/phone/start`

Registra/atualiza o telefone do usuário. **Não há provedor de SMS**: o número é salvo diretamente e a verificação por OTP em `/phone/verify` é um no-op. O contrato (`200 { ok: true }`) foi preservado.

**Body**
```json
{ "phone": "+5511999990000" }
```

**Response 200**
```json
{ "ok": true }
```

**Response 400** `invalid_payload` / `update_failed`.

---

### `POST /api/protected/user/phone/verify`

**No-op** — não há provedor de SMS; o telefone já foi salvo em `/phone/start`. Mantido para preservar o contrato: responde `200 { ok: true }` para qualquer `phone`/`token` não vazios.

**Body**
```json
{ "phone": "+5511999990000", "token": "123456" }
```

**Response 200**
```json
{ "ok": true }
```

**Response 400** `invalid_payload` — `phone`/`token` vazios. *(No-op: só há `400 invalid_payload` ou `200 { ok: true }`; não existe `verify_failed`.)*

---

### `PATCH /api/protected/user/password`

Redefine a senha do usuário. Usado na etapa final do fluxo "Esqueci minha senha". Não usa a sessão: o token de redefinição vem do cookie HttpOnly `ba_reset`, que o `GET /public/auth/callback` grava (vale 1 h e só é enviado para esta rota). Sem o cookie, mesmo com sessão aberta, a resposta é `401 reset_password_invalid_token`. Com sucesso, o cookie é apagado.

**Body**
```json
{ "password": "sol azul de manha", "confirmPassword": "sol azul de manha" }
```

A senha segue a regra do cadastro: pelo menos 10 caracteres, `confirmPassword` igual e nota 4 no zxcvbn.

**Response 200**
```json
{ "ok": true, "message": "Senha redefinida com sucesso." }
```

**Erros Possíveis**

| Status | Código | Descrição |
|---|---|---|
| `400` | `invalid_payload` | Body fora do schema |
| `400` | `reset_password_weak` | Senha muito fraca |
| `401` | `reset_password_invalid_token` | Link/sessão de recuperação expirado ou inválido |
| `400` | `reset_password_failed` | Falha genérica ao redefinir |
| `503` | `service_unavailable` | Serviço de autenticação indisponível (Better Auth respondeu 5xx) |

---

### `POST /api/auth/delete-user`

"Excluir minha conta" (etapa 07, LGPD art. 18). Handler nativo do Better Auth (`user.deleteUser` em `src/auth/auth.ts`), com a sessão do cookie.

Apaga **tudo**, sem volta. Antes de apagar o usuário, `deleteEnterpriseOfUser` (`src/auth/enterpriseOnDelete.ts`) apaga, numa transação, a empresa (feedbacks, análises, catálogo, perguntas, pontos de coleta, aparelhos, configuração de IA, jobs e diagnósticos vão em cascata) e as tabelas sem chave estrangeira para ela: `customer`, `collecting_data_enterprise`, `ia_rate_budget` e os links de nova senha. Depois o Better Auth apaga o usuário, e `session`, `account` e `user_onboarding` vão em cascata. O cookie de sessão é limpo.

**Body**
```json
{ "password": "senhaAtual" }
```

Com `password`, o Better Auth confere a senha (a Web sempre pede a senha a quem tem uma). Sem `password`, como quem só entra pelo Google, ele exige uma sessão recente (entrada nas últimas 24 h).

**Response 200**
```json
{ "success": true, "message": "User deleted" }
```

**Erros Possíveis** (códigos do Better Auth)

| Status | Código | Descrição |
|---|---|---|
| `400` | `INVALID_PASSWORD` | Senha errada |
| `400` | `CREDENTIAL_ACCOUNT_NOT_FOUND` | Mandou senha, mas a conta só entra pelo Google |
| `400` | `SESSION_EXPIRED` | Sem senha e com a sessão aberta há mais de 24 h: entrar de novo |
| `401` | — | Sem sessão |

---

## Onboarding (guia do sistema)

O guia é do **usuário**, não da empresa: a leitura e a gravação usam o id da sessão. As respostas usam `Cache-Control: no-store`.

### `GET /api/protected/user/onboarding/system-guide`

Diz se o usuário já terminou ou pulou o guia do sistema.

**Response 200**
```json
{ "tourKey": "system-guide", "version": 1, "status": "pending", "finishedAt": null }
```

> `status` ∈ `pending` (nunca terminou nem pulou) · `completed` · `skipped`. `finishedAt` é o ISO de quando terminou ou pulou (`null` em `pending`).

**Response 500** `internal_error`.

---

### `PUT /api/protected/user/onboarding/system-guide`

Grava o fim do guia.

**Body** — só estes campos; campos extras são recusados.
```json
{ "version": 1, "status": "completed" }
```

- `version` precisa ser a versão atual do guia (`1`); `status` ∈ `completed` · `skipped`.
- `completed` sempre prevalece: depois de concluir, um `skipped` não volta atrás. Repetir o mesmo status mantém o `finishedAt`; só a passagem de `skipped` para `completed` renova a data.

**Response 200** — mesmo formato do `GET`.

**Response 400** `invalid_payload` · **500** `internal_error`.

---

## Enterprise

### `GET /api/protected/user/enterprise`

Retorna os dados cadastrais da empresa associada ao usuário autenticado, incluindo o status do trial/assinatura.

**Response 200**
```json
{
  "enterprise": {
    "id": "uuid",
    "terms_version": "v1",
    "terms_accepted_at": "2026-01-15T10:00:00Z",
    "created_at": "2026-01-15T10:00:00Z",
    "trial_ends_at": "2026-05-15T10:00:00Z",
    "subscription_status": "TRIAL"
  },
  "user": {
    "id": "uuid",
    "email": "gestor@empresa.com",
    "phone": "+5511999990000"
  }
}
```

> Do usuário, este endpoint retorna apenas `id`, `email` e `phone` — **não** inclui `full_name`. O `full_name` é exposto via `user_metadata.full_name` por outros endpoints (`GET /user/auth_user`, `PATCH /user/metadados`).

**Response 404** `enterprise_not_found` — usuário sem empresa.

---

### `PATCH /api/protected/user/enterprise`

Atualiza dados cadastrais parciais da empresa (versão e aceite dos termos).

**Body (os dois são opcionais, mas pelo menos um precisa vir)**
```json
{
  "terms_version": "v2",
  "terms_accepted_at": "2026-05-24T10:00:00Z"
}
```

`terms_version` tem de 1 a 32 caracteres; `terms_accepted_at` é data e hora ISO 8601.

> O CPF/CNPJ não é mais pedido nem guardado (migration `0009`): o sistema não usa esse dado (LGPD, necessidade).

**Response 200** — mesmo formato de `GET /enterprise`.

**Response 400** `invalid_payload` (body vazio ou fora do schema) · **401** `enterprise_not_found` (usuário sem empresa; o código vem com `401`, não `404`).

---

### `GET /api/protected/user/collecting_data`

Retorna as configurações de coleta da empresa — tipos ativos, catálogo e perguntas.

**Response 200** — tudo aninhado em `collecting` (ou `{ "collecting": null }` quando não há registro).
```json
{
  "collecting": {
    "id": "uuid",
    "enterprise_id": "uuid",
    "company_objective": "...",
    "analytics_goal": "...",
    "business_summary": "...",
    "main_products_or_services": ["...", "..."],
    "uses_company_products": true,
    "uses_company_services": false,
    "uses_company_departments": false,
    "created_at": "2026-01-15T10:00:00Z",
    "updated_at": "2026-01-15T10:00:00Z",
    "catalog_products": [...],
    "catalog_services": [...],
    "catalog_departments": [...],
    "company_feedback_questions": [...]
  }
}
```

- `catalog_*` traz só os itens `ACTIVE`, ordenados por `sort_order`; `company_feedback_questions` são as perguntas COMPANY, cada uma com as `subquestions`.
- Como esta leitura é feita em toda página protegida, ela também aciona o worker se a empresa tiver job de IA parado na fila.

**Response 404** `collecting_data_not_found` — falha ao ler os dados de coleta.

---

### `PATCH /api/protected/user/collecting_data`

Atualiza parcialmente as configurações de coleta: só os campos enviados mudam.

**Body** — os campos do `GET` (`company_objective`, `analytics_goal`, `business_summary`, `main_products_or_services`, `uses_company_*`), mais:

- `catalog_products` / `catalog_services` / `catalog_departments`: a lista do tipo, com itens `{ id?, name, description?, sort_order?, status? }`. Item sem `name` é ignorado. `uses_company_<tipo>: false` desativa todos os itens do tipo.
- `company_feedback_questions`: as 3 perguntas COMPANY (`question_order` 1 a 3), cada uma com 20 a 150 caracteres e até 3 subperguntas no mesmo limite.

**Response 200** — mesmo formato de `GET` (objeto `collecting`).

**Erros:** `400 empty_payload` (nenhum campo conhecido), `400 upsert_failed` (perguntas inválidas ou falha de integridade ao gravar), `404 enterprise_not_found`.

### `PUT /api/protected/user/collecting_data`

Upsert completo (cria se não existir, substitui se existir). Campo ausente vira `null`/`false`, os três catálogos são sincronizados e as 3 perguntas COMPANY também; sem `company_feedback_questions`, entram as perguntas padrão. **Response 200** — mesmo formato de `GET` (objeto `collecting`). Erros: `400 upsert_failed` e `404 enterprise_not_found`.

> **Perguntas automáticas da empresa.** O `PUT` e o `PATCH` que mexe nos campos da empresa (não só no catálogo ou nas perguntas) tentam gerar as 3 perguntas COMPANY com a IA (`autoGenerateCompanyQuestions`). Só sai pedido quando a empresa tem os três campos de contexto, a IA configurada e as perguntas ainda são as padrão. O resultado não volta nesta resposta: a Web acompanha por `GET /ia-analyze/jobs/company-questions/latest`.

---

## Feedbacks

### `GET /api/protected/user/feedbacks`

Lista todos os feedbacks da empresa com paginação e filtros. Inclui os do "Testar o formulário" (`channel: "TEST"`), para a Web marcá-los como teste. Todas as outras leituras de feedback (métricas, mínimo de 10, análise e diagnóstico da IA, clientes que voltam) deixam esses testes de fora.

**Query Params**

| Parâmetro | Tipo | Descrição |
|---|---|---|
| `page` | `number` | Página atual (padrão: `1`) |
| `limit` | `number` | Itens por página (padrão: `10`) |
| `rating` | `number` | Filtra por nota (1–5) |
| `search` | `string` | Busca textual na mensagem |
| `item` | `string` | Filtra por nome do item de catálogo (busca parcial) |
| `category` | `COMPANY \| PRODUCT \| SERVICE \| DEPARTMENT` | Filtra por tipo de escopo |

**Response 200**
```json
{
  "feedbacks": [
    {
      "id": "uuid",
      "message": "Ótimo atendimento!",
      "rating": 5,
      "channel": "QR | LINK | NFC | TEST | null",
      "created_at": "2026-05-12T12:00:00Z",
      "updated_at": "2026-05-12T12:00:00Z",
      "collection_points": {
        "id": "uuid",
        "name": "Caixa Principal",
        "type": "QR_CODE",
        "identifier": "uuid | null",
        "catalog_item_id": "uuid | null",
        "catalog_item_name": "Produto X | null",
        "catalog_item_kind": "PRODUCT | SERVICE | DEPARTMENT | null",
        "catalog_items": { "name": "Produto X", "kind": "PRODUCT" }
      },
      "tracked_devices": {
        "id": "uuid",
        "device_fingerprint": "md5",
        "user_agent": "Mozilla/5.0 ...",
        "ip_address": "203.0.113.10",
        "feedback_count": 1,
        "is_blocked": false,
        "customer_id": "uuid | null",
        "customer": { "id": "uuid", "name": "Maria", "email": "maria@exemplo.com", "gender": "Feminino" }
      },
      "feedback_question_answers": [
        { "question_id": "uuid", "question_text_snapshot": "Como você avalia o atendimento?", "answer_value": "OTIMA", "answer_score": 5 }
      ]
    }
  ],
  "pagination": {
    "currentPage": 1,
    "totalPages": 5,
    "totalItems": 42,
    "itemsPerPage": 10,
    "hasNextPage": true,
    "hasPreviousPage": false
  }
}
```

- Ordem: mais recentes primeiro. `search` busca no texto do comentário (`ILIKE`, sem diferença de maiúsculas).
- `catalog_items` é `null` no QR da empresa; `tracked_devices` é `null` sem aparelho, e `customer` é `null` sem cliente vinculado.

**Erros:** `404 enterprise_not_found` · `500 internal_server_error`.

---

### `GET /api/protected/user/feedbacks/stats`

Retorna estatísticas agregadas dos feedbacks da empresa.

**Query Params**

| Parâmetro | Tipo | Descrição |
|---|---|---|
| `scope_type` | `COMPANY \| PRODUCT \| SERVICE \| DEPARTMENT` | Segmenta as estatísticas por escopo. **Omitido = todos os escopos** (sem filtro); envie `COMPANY` explicitamente para o QR geral |
| `catalog_item_id` | `string` | Segmenta por item de catálogo específico |
| `start_date` | `string` (ISO 8601) | Início do período, **incluído**. Ex.: `2026-09-17T03:00:00Z` |
| `end_date` | `string` (ISO 8601) | Fim do período, **excluído**. Sem `start_date` e `end_date` = histórico inteiro |

**Response 200**
```json
{
  "totalFeedbacks": 120,
  "averageRating": 4.2,
  "ratingDistribution": {
    "1": 3,
    "2": 12,
    "3": 25,
    "4": 40,
    "5": 40
  },
  "sentimentBreakdown": {
    "positive": 80,
    "neutral": 25,
    "negative": 15
  },
  "totalAnalyzed": 87,
  "pendingCount": 33,
  "latestAnalysisAt": "2026-06-18T09:30:00Z",
  "starMean": 4.2,
  "starMeanCI": { "lower": 4.05, "upper": 4.35 },
  "netSatisfaction": 53.3,
  "csat": { "pct": 66.7, "ci": { "lower": 57.8, "upper": 74.5 } },
  "confidenceTier": "good",
  "aiSentiment": {
    "positive": 60,
    "neutral": 20,
    "negative": 7,
    "netSentimentScore": 60.9,
    "confidenceTier": "moderate"
  }
}
```

O endpoint expõe **duas lentes** complementares, ambas segmentadas pelo escopo (`scope_type` / `catalog_item_id`):

- **Lente SATISFAÇÃO (estrelas):** `starMean` (média de notas 1–5) com `starMeanCI` (IC t, em unidade de nota), `netSatisfaction` (%(4–5) − %(1–2), em [-100,100]), `csat` (Top-2-Box: % de notas 4–5 + IC de Wilson em %) e `confidenceTier` pela quantidade de feedbacks no escopo.
- **Lente SENTIMENTO (IA/texto):** `aiSentiment` agrega o sentimento classificado pela IA sobre o **subconjunto já analisado**, com `netSentimentScore` (NSS = (pos−neg)/analisados × 100) e `confidenceTier` por quantidade analisada. **Só está presente quando `totalAnalyzed > 0`** (omitido caso contrário).

`channelBreakdown` diz por onde chegaram as avaliações no recorte: `[{ channel: "QR" | "LINK" | "NFC" | null, count, mean, ci }]`, na ordem QR, link, NFC e sem marca (`null`, os feedbacks de antes da etapa 06 e QR Codes antigos). Canal sem avaliação no recorte não aparece. O `TEST` não entra, como em todas as métricas.

`commentParticipation` diz quantos escreveram comentário: `total`, `withComment`, `pct` com o IC em `ci`, `confidenceTier`, a média das estrelas de quem comentou e de quem não comentou (`withCommentRating` / `withoutCommentRating`, `{ n, mean, ci }` ou `null`) e quantos desses comentários são curtos, com menos de 20 caracteres (`shortComments`). `commentField` diz como está o campo de comentário nos pontos de coleta do recorte: `hidden` ∈ `all` · `some` · `none` e `prompt` (a pergunta própria, quando o recorte é um ponto só). A Web usa os dois para sugerir mudar o campo, pela mesma regra que vai ao diagnóstico da IA.

`totalAnalyzed`/`pendingCount` indicam quantos feedbacks do escopo já têm análise da IA e quantos faltam. Como o comentário é opcional, só quem escreveu espera pela IA: `pendingCount = max(0, commentParticipation.withComment − totalAnalyzed)`. `latestAnalysisAt` é o timestamp ISO da análise mais recente (ou `null`).

> `sentimentBreakdown` é derivado **por estrela** (positive = notas 4–5, neutral = 3, negative = 1–2) e mantido por **compatibilidade**. O sentimento real do texto vem da IA em `aiSentiment` — as duas leituras podem divergir.
>
> `confidenceTier` ∈ `insufficient` (<10) · `low` (10–29) · `moderate` (30–99) · `good` (100+).

**Período (etapa 02).** `stats`, `questions` e `analysis` aceitam `start_date`/`end_date` e recortam pela data de criação do feedback (`created_at`), no intervalo meio aberto `[start_date, end_date)`. A Web resolve "últimos 30 dias" etc. no fuso do gestor e envia instantes absolutos. Sem as duas datas, o comportamento é o de antes (histórico inteiro). Data fora do ISO 8601 ou `start_date >= end_date` → **400** `invalid_period`. Com período, `totalAnalyzed`/`pendingCount` também ficam recortados; o aviso de "aguardando análise" e o relatório de insights seguem sem período.

---

### `GET /api/protected/user/feedbacks/timeline`

Movimento no tempo: quantas avaliações chegaram e a média das notas em cada dia, semana ou mês, no escopo e no período escolhidos. O banco agrupa por `date_trunc(bucket, created_at AT TIME ZONE tz)`. Os intervalos sem avaliação vêm com `count: 0` e `mean: null`, para o gráfico não pular datas.

**Query Params**

| Parâmetro | Tipo | Descrição |
|---|---|---|
| `scope_type` | `COMPANY \| PRODUCT \| SERVICE \| DEPARTMENT` | Segmenta por escopo, como em `/stats` |
| `catalog_item_id` | `string` | Segmenta por item de catálogo específico |
| `start_date` | `string` (ISO 8601) | Início do período, **incluído** |
| `end_date` | `string` (ISO 8601) | Fim do período, **excluído** |
| `bucket` | `day \| week \| month` | Tamanho de cada intervalo. Padrão `day`. A semana começa na segunda |
| `tz` | `string` (fuso IANA) | Fuso em que as datas são agrupadas. Padrão `America/Sao_Paulo` |

- **Começo da série:** o início do período ou, sem ele, a primeira avaliação do escopo.
- **Fim da série:** o fim do período ou, sem ele, hoje no fuso pedido.
- **Teto:** a série tem no máximo 400 intervalos. Para intervalos longos, use `week` ou `month`.

**Response 200**
```json
{
  "bucket": "day",
  "tz": "America/Sao_Paulo",
  "total": 7,
  "points": [
    { "start": "2026-10-12", "count": 0, "mean": null },
    { "start": "2026-10-13", "count": 4, "mean": 4.5 },
    { "start": "2026-10-14", "count": 3, "mean": 3.67 }
  ]
}
```

**Erros**

| Status | Código | Quando |
|---|---|---|
| 400 | `invalid_period` | Datas fora do ISO 8601 ou `start_date >= end_date` |
| 400 | `invalid_timeline` | `bucket` fora de `day`/`week`/`month` ou fuso inválido |
| 400 | `timeline_too_many_points` | Mais de 400 intervalos no agrupamento pedido |
| 404 | `enterprise_not_found` | Usuário sem empresa |

---

### `GET /api/protected/user/feedbacks/heatmap`

Dias e horários de pico: quantas avaliações chegaram e a média das notas em cada **dia da semana × faixa do dia**, no escopo e no período escolhidos, no fuso do gestor. As faixas têm 6 horas em vez de uma hora, porque com pouco volume a grade de 24 horas fica vazia. A resposta traz sempre as 28 células; as que não tiveram avaliação vêm com `count: 0` e `mean: null`.

**Query Params**

| Parâmetro | Tipo | Descrição |
|---|---|---|
| `scope_type` | `COMPANY \| PRODUCT \| SERVICE \| DEPARTMENT` | Segmenta por escopo, como em `/stats` |
| `catalog_item_id` | `string` | Segmenta por item de catálogo específico |
| `start_date` | `string` (ISO 8601) | Início do período, **incluído** |
| `end_date` | `string` (ISO 8601) | Fim do período, **excluído** |
| `tz` | `string` (fuso IANA) | Fuso em que dia e hora são lidos. Padrão `America/Sao_Paulo` |

- `weekday`: dia da semana como o `extract(dow)` do Postgres, de 0 (domingo) a 6 (sábado).
- `band`: faixa do dia. São 0 (madrugada, 0–6h), 1 (manhã, 6–12h), 2 (tarde, 12–18h) e 3 (noite, 18–24h).

**Response 200**
```json
{
  "tz": "America/Sao_Paulo",
  "total": 13,
  "cells": [
    { "weekday": 0, "band": 0, "count": 0, "mean": null },
    { "weekday": 5, "band": 2, "count": 10, "mean": 3.4 },
    { "weekday": 6, "band": 3, "count": 3, "mean": 5 }
  ]
}
```

**Erros**

| Status | Código | Quando |
|---|---|---|
| 400 | `invalid_period` | Datas fora do ISO 8601 ou `start_date >= end_date` |
| 400 | `invalid_timeline` | Fuso inválido |
| 404 | `enterprise_not_found` | Usuário sem empresa |

---

### `GET /api/protected/user/feedbacks/customers`

Clientes que voltam: quantas avaliações vieram de quem já tinha avaliado a empresa e se a nota de quem volta é maior ou menor que a de quem avalia pela primeira vez, no escopo e no período escolhidos.

- **Quem é o cliente:** o aparelho identificado pelo anti-spam (`tracked_device_id`). Por isso o número é aproximado, e a resposta não traz nenhum dado pessoal. O fingerprint do aparelho inclui o dia (`MD5(userAgent | IP | dia)`, ver `POST /public/qrcode/feedback`), então o mesmo aparelho ganha outro registro a cada dia.
- **Quando a avaliação é "de quem volta":** quando o mesmo aparelho já tinha avaliado a **empresa** antes, em qualquer escopo. A numeração usa `row_number()` por aparelho, com o filtro de empresa dentro da subconsulta; escopo e período recortam depois.
- **Sem aparelho:** essas avaliações ficam de fora dos percentuais e são contadas em `unidentified`.

**Query Params**

| Parâmetro | Tipo | Descrição |
|---|---|---|
| `scope_type` | `COMPANY \| PRODUCT \| SERVICE \| DEPARTMENT` | Segmenta por escopo, como em `/stats` |
| `catalog_item_id` | `string` | Segmenta por item de catálogo específico |
| `start_date` | `string` (ISO 8601) | Início do período, **incluído** |
| `end_date` | `string` (ISO 8601) | Fim do período, **excluído** |

**Response 200**
```json
{
  "identified": 50,
  "unidentified": 5,
  "firstTimeCount": 40,
  "returningCount": 10,
  "returningPct": 20,
  "returningPctCI": { "lower": 11.2, "upper": 33.0 },
  "customers": 45,
  "returningCustomers": 7,
  "firstTime": { "n": 40, "mean": 3.75, "ci": { "lower": 3.55, "upper": 3.95 } },
  "returning": { "n": 10, "mean": 4.8, "ci": { "lower": 4.5, "upper": 5 } }
}
```

| Campo | O que é |
|---|---|
| `identified` | avaliações com aparelho identificado |
| `returningPct` | % de `returningCount` sobre `identified`, com o IC de Wilson em `returningPctCI`; os dois são `null` com `identified = 0` |
| `customers` | aparelhos distintos no escopo e no período |
| `returningCustomers` | desses aparelhos, os que avaliaram de novo no escopo e no período |
| `firstTime` / `returning` | média das estrelas de cada grupo, com o IC t; `null` sem avaliações |

**Erros:** `400 invalid_period` (datas inválidas) e `404 enterprise_not_found`.

---

### `GET /api/protected/user/feedbacks/questions`

Retorna métricas agregadas **por pergunta e subpergunta** no escopo selecionado, na escala 1–5. São métricas **determinísticas** — calculadas só sobre as respostas estruturadas (nota por rótulo), **não dependem da IA**. Usado pela aba "Perguntas".

**Query Params**

| Parâmetro | Tipo | Descrição |
|---|---|---|
| `scope_type` | `COMPANY \| PRODUCT \| SERVICE \| DEPARTMENT` | Segmenta por escopo |
| `catalog_item_id` | `string` | Segmenta por item de catálogo específico |
| `start_date` | `string` (ISO 8601) | Início do período, **incluído**. Ex.: `2026-09-17T03:00:00Z` |
| `end_date` | `string` (ISO 8601) | Fim do período, **excluído**. Sem `start_date` e `end_date` = histórico inteiro |

**Response 200** — `questions` ordenado **pior → melhor** (menor nota média no topo).
```json
{
  "questions": [
    {
      "question_id": "uuid",
      "text": "Como você avalia o atendimento?",
      "count": 42,
      "mean": 3.4,
      "ci": { "lower": 3.1, "upper": 3.7 },
      "satisfiedPct": 55.0,
      "distribution": {
        "PESSIMO": 4,
        "RUIM": 6,
        "MEDIANA": 9,
        "BOA": 12,
        "OTIMA": 11
      },
      "confidenceTier": "moderate",
      "ratingWeight": { "r": 0.62, "ci": { "lower": 0.39, "upper": 0.78 }, "n": 42 },
      "status": "current",
      "subquestions": [
        {
          "subquestion_id": "uuid",
          "text": "O tempo de espera foi adequado?",
          "count": 30,
          "mean": 3.1,
          "ci": { "lower": 2.8, "upper": 3.4 },
          "satisfiedPct": 50.0,
          "distribution": {
            "PESSIMO": 3,
            "RUIM": 5,
            "MEDIANA": 7,
            "BOA": 9,
            "OTIMA": 6
          },
          "confidenceTier": "moderate",
          "status": "current"
        }
      ]
    }
  ]
}
```

Por pergunta (e por subpergunta): `mean` (nota média 1–5), `ci` (faixa provável da média, IC t em unidade de nota), `satisfiedPct` (% de respostas BOA+ÓTIMA), `distribution` (contagem por rótulo `PESSIMO`/`RUIM`/`MEDIANA`/`BOA`/`OTIMA`), `confidenceTier` (pela quantidade de respostas) e `status`:

- `current` — pergunta ativa e com o texto atual da configuração;
- `deactivated` — a configuração ainda tem esta redação, mas está desativada (toggle off);
- `past` — redação antiga (texto editado) ou pergunta removida da configuração.

**O que mais pesa na nota (`ratingWeight`, só nas perguntas).** É a correlação de Spearman entre a nota da pergunta e as estrelas **do mesmo feedback**, com o IC 95% (Fisher z, erro padrão de Bonett–Wright) e o número de pares `n`.

- **Leitura de `r`:** perto de 1, as duas notas sobem e descem juntas, então a pergunta pesa na nota geral. Perto de 0, ela pesa pouco. Negativo, as duas vão em sentidos contrários.
- **Quando vem `null`:** com menos de 4 pares, ou quando uma das notas não varia.
- **Limite:** mostra o que anda junto com a nota, não prova a causa. A Web só exibe o peso a partir de 30 respostas.

> Cada redação distinta de uma mesma pergunta vira uma entrada própria (o `question_id` é estável; o snapshot de texto pode mudar), o que separa "atuais" de "antigas".
>
> Escopo sem feedbacks (ou item inexistente) → `{ "questions": [] }`.

---

### `GET /api/protected/user/feedbacks/insights/report`

Retorna o relatório de insights armazenado no banco (leitura — não dispara nova análise).

**Query Params**

| Parâmetro | Tipo | Descrição |
|---|---|---|
| `scope_type` | `COMPANY \| PRODUCT \| SERVICE \| DEPARTMENT` | Filtra por escopo (padrão: `COMPANY`) |
| `catalog_item_id` | `string` | Filtra por item específico |

**Response 200**
```json
{
  "summary": "A maioria dos feedbacks é positiva, com destaque para atendimento.",
  "recommendations": ["Manter padrão de atendimento", "Reduzir tempo de espera"],
  "updatedAt": "2026-05-12T12:00:00Z",
  "scopeType": "COMPANY",
  "catalogItemId": null
}
```

> Quando não há relatório gerado ainda, retorna `summary: null`, `recommendations: []` e `updatedAt: null`, com o `scopeType`/`catalogItemId` pedidos.

---

### `GET /api/protected/user/feedbacks/analysis`

Retorna os feedbacks já analisados pela IA com sentimento, categorias e keywords por item. Usado pelo painel de analytics.

**Query Params**

| Parâmetro | Tipo | Descrição |
|---|---|---|
| `sentiment` | `positive \| neutral \| negative` | Filtra por sentimento |
| `scope_type` | `COMPANY \| PRODUCT \| SERVICE \| DEPARTMENT` | Filtra por escopo |
| `catalog_item_id` | `string` | Filtra por item específico |
| `start_date` | `string` (ISO 8601) | Início do período, **incluído**. Ex.: `2026-09-17T03:00:00Z` |
| `end_date` | `string` (ISO 8601) | Fim do período, **excluído**. Sem `start_date` e `end_date` = histórico inteiro |

**Response 200**
```json
{
  "items": [
    {
      "id": "uuid",
      "message": "Ótimo atendimento!",
      "rating": 5,
      "created_at": "2026-05-12T12:00:00Z",
      "sentiment": "positive",
      "categories": ["atendimento", "rapidez"],
      "keywords": ["excelente", "equipe"],
      "discrepancy": null,
      "aspects": [
        { "aspect": "atendimento", "sentiment": "positive", "sentiment_score": 0.8 }
      ],
      "sentiment_score": 0.75,
      "confidence": 0.92
    }
  ],
  "summary": {
    "totalAnalyzed": 87,
    "sentiments": { "positive": 60, "neutral": 20, "negative": 7 },
    "topCategories": [
      { "name": "atendimento", "count": 34, "proportion": 0.39, "ci": { "lower": 0.29, "upper": 0.5 } }
    ],
    "topKeywords": [
      { "name": "excelente", "count": 28, "proportion": 0.32, "ci": { "lower": 0.23, "upper": 0.43 } }
    ],
    "netSentimentScore": 60.9,
    "sentimentCIs": {
      "positive": { "lower": 0.59, "upper": 0.78 },
      "neutral": { "lower": 0.15, "upper": 0.33 },
      "negative": { "lower": 0.04, "upper": 0.16 }
    },
    "confidenceTier": "moderate",
    "aspectSentiments": [
      {
        "aspect": "tempo de espera",
        "positive": 4,
        "neutral": 3,
        "negative": 12,
        "count": 19,
        "netSentimentScore": -42.1,
        "ci": { "lower": 0.09, "upper": 0.45 }
      }
    ]
  }
}
```

Por item, além de `sentiment`/`categories`/`keywords`:

- `aspects[]` — sentimento por aspecto (ABSA) extraído do texto (`{ aspect, sentiment, sentiment_score }`);
- `sentiment_score` — intensidade graduada do sentimento geral em [-1, 1];
- `confidence` — confiança da classificação em [0, 1];
- `discrepancy` — divergência entre a nota (estrela) e o sentimento do texto: `silent_detractor` (nota alta + texto negativo), `rating_misuse` (nota baixa + texto positivo) ou `null`.

No `summary`: `netSentimentScore` (NSS sobre os analisados), `sentimentCIs` (IC de Wilson por classe, em fração 0..1), `confidenceTier` e `aspectSentiments[]` (ABSA agregado, com gate de menção mínima 3 e ordenado por impacto volume × |NSS|, top 12). `topCategories`/`topKeywords` passam a trazer `{ name, count, proportion, ci }`, ranqueados pelo **limite inferior de Wilson** da proporção (top 10 cada).

---

## QR Code (Gestão)

Endpoints protegidos para o gestor controlar os pontos de coleta (QR Codes) da empresa e do catálogo.

### `GET /api/protected/user/collection-points/qr/status`

Retorna se o QR Code da empresa (escopo `COMPANY`) está ativo.

**Response 200**
```json
{ "active": true, "id": "uuid | null" }
```

**Erros:** `404 enterprise_not_found` e `500 collection_point_error`, os dois com `active: false` no corpo.

---

### `POST /api/protected/user/collection-points/qr/enable`

Ativa (ou cria) o ponto de coleta de QR Code da empresa.

**Response 200**
```json
{ "id": "uuid", "active": true }
```

**Erros:** `404 enterprise_not_found` · `500 unable_to_create_qr_cp` ou `unable_to_activate_qr`.

---

### `POST /api/protected/user/collection-points/qr/disable`

Desativa o ponto de coleta de QR Code da empresa.

**Response 200**
```json
{ "active": false }
```

**Erros:** `404 enterprise_not_found` · `500 unable_to_disable_qr`.

---

### `GET /api/protected/user/collection-points/qr/catalog`

Lista os itens de catálogo de um tipo, com o status do QR Code e o snapshot de perguntas de cada um.

**Query Params**

| Parâmetro | Tipo | Descrição |
|---|---|---|
| `kind` | `PRODUCT \| SERVICE \| DEPARTMENT` | Tipo de item de catálogo (obrigatório) |

**Response 200**
```json
{ "items": [ { "catalog_item_id": "uuid", "name": "Produto X", "description": "...", "kind": "PRODUCT", "active": true, "collection_point_id": "uuid | null", "questions": [] } ] }
```

**Response 400** `collection_point_error` — `kind` inválido ou ausente. **404** `enterprise_not_found` · **500** `collection_point_error`.

---

### `POST /api/protected/user/collection-points/qr/catalog/questions/upsert`

Cria/atualiza as perguntas dinâmicas de um item de catálogo. O array `questions` deve conter **sempre os 3 slots** (`question_order` 1, 2 e 3); desses, **até 3 podem ter texto** (20–150 caracteres cada) e os demais ficam vazios. O controller não exige um mínimo: os 3 vazios desativam todas as perguntas do item. Cada slot aceita até 3 subperguntas (`subquestion_order`, `subquestion_text`, `is_active`), no mesmo limite de 20–150 caracteres. Slot com texto é gravado como ativo; esvaziar um slot faz **soft-delete** (`is_active = false`), preservando o histórico de respostas; o editor lê apenas registros `is_active = true`.

**Body**
```json
{
  "catalog_item_id": "uuid",
  "questions": [
    { "question_order": 1, "question_text": "Como você avalia o atendimento?", "subquestions": [] },
    { "question_order": 2, "question_text": "", "subquestions": [] },
    { "question_order": 3, "question_text": "", "subquestions": [] }
  ]
}
```

**Response 200**
```json
{ "catalog_item_id": "uuid", "questions": [] }
```

**Response 400** `invalid_payload`, com o motivo em `reason`:

| `reason` | Quando |
|---|---|
| `catalog_item_id_missing` | Sem `catalog_item_id` |
| `questions_must_have_3_slots` | `questions` não é um array de 3 itens |
| `question_length_invalid` / `subquestion_length_invalid` | Texto fora de 20–150 caracteres (vem com `question_order` e, na subpergunta, `subquestion_order`) |
| `active_question_without_text` / `active_subquestion_without_text` | `is_active: true` com o texto vazio |
| `duplicate_question_order` / `duplicate_subquestion_order` | Ordem repetida |
| `question_not_object` / `subquestion_not_object` | Item que não é objeto |

**Response 404** `collection_point_error` (item inexistente, de outra empresa ou inativo) ou `enterprise_not_found`. **500** `update_failed` — falha ao gravar (nada é salvo).

---

### `POST /api/protected/user/collection-points/qr/catalog/enable`

Ativa (ou cria) o QR Code de um item de catálogo específico.

**Body**
```json
{ "catalog_item_id": "uuid" }
```

**Response 200**
```json
{ "catalog_item_id": "uuid", "collection_point_id": "uuid", "active": true }
```

**Erros:** `400 collection_point_error` (sem `catalog_item_id`) · `404 collection_point_error` (item inexistente, de outra empresa ou inativo) · `404 enterprise_not_found` · `500 unable_to_create_qr_cp` ou `unable_to_activate_qr`.

---

### `POST /api/protected/user/collection-points/qr/catalog/disable`

Desativa o QR Code de um item de catálogo específico.

**Body**
```json
{ "catalog_item_id": "uuid" }
```

**Response 200**
```json
{ "catalog_item_id": "uuid", "active": false }
```

**Erros:** `400 collection_point_error` (sem `catalog_item_id`) · `404 enterprise_not_found` · `500 unable_to_disable_qr`.

---

### `GET /api/protected/user/collection-points/comment-field`

Campo de comentário do formulário de um escopo: a empresa (`scope_type=COMPANY`) ou um item do catálogo (`scope_type` do item + `catalog_item_id`). Sem configuração salva, vale o convite padrão.

**Response 200**
```json
{ "mode": "DEFAULT | CUSTOM | HIDDEN", "prompt": "O que faltou no atendimento? | null" }
```

**Response 400** `invalid_payload` — escopo ou id inválido. **404** `catalog_item_not_found` — item de outra empresa ou de outro tipo.

---

### `PUT /api/protected/user/collection-points/comment-field`

Salva o campo de comentário de um escopo (uma configuração por empresa ou por item).

**Body**
```json
{ "scope_type": "PRODUCT", "catalog_item_id": "uuid", "mode": "CUSTOM", "prompt": "O que mudaria neste produto?" }
```

| `mode` | No formulário |
|---|---|
| `DEFAULT` | Convite padrão ("Conte-nos mais sobre sua experiência"), opcional |
| `CUSTOM` | A pergunta de `prompt` (10 a 150 caracteres) no lugar do convite, opcional |
| `HIDDEN` | Sem campo de comentário; o envio ignora o texto, se vier |

`prompt` só é guardado no modo `CUSTOM`. `catalog_item_id` é obrigatório fora de `COMPANY` e proibido nela.

**Response 200** — a configuração salva, no formato do `GET`. **400** `invalid_payload` · **404** `catalog_item_not_found`.

---

## IA Analyze

As duas operações **sempre enfileiram** e respondem `202`. Não há modo síncrono
selecionável por ambiente. O frontend consulta o job, sem esperar a IA no POST.

### `POST /api/protected/ia-analyze/analyze-raw`

Enfileira análise dos feedbacks ainda não analisados. Body:

```json
{ "scope_type": "PRODUCT", "catalog_item_id": "uuid-do-produto", "limit": 50 }
```

- `scope_type`: COMPANY (padrão), PRODUCT, SERVICE ou DEPARTMENT.
- `catalog_item_id`: item do escopo, se aplicável.
- `limit`: opcional, máximo explícito 100. Sem limite, inclui todos os pendentes
  do escopo no snapshot.
- Validação de contexto/mínimo de dez feedbacks ocorre no worker. Sem pendentes,
  o job conclui com zero; não chama a IA.

Resposta:

```json
{ "jobId": "uuid", "status": "queued" }
```

Um pedido duplicado devolve o job ativo existente, que pode já estar running.

### `POST /api/protected/ia-analyze/regenerate-insights`

```json
{
  "scope_type": "COMPANY",
  "catalog_item_id": null,
  "force": false,
  "analyze_pending": true
}
```

- `analyze_pending` (padrão false): quando true, o mesmo job primeiro analisa
  pendentes e depois produz o relatório. Essa sequência não depende do navegador.
- `force` (padrão false): ignora o cache de relatório.
- Usa todos os analisados do escopo, em lotes retomáveis. O relatório só é
  publicado após todos os lotes concluírem.
- Resposta: `202 { "jobId": "uuid", "status": "queued" }`.

Falhas de autenticação/empresa/fila podem retornar 401/404/500 no POST. Erros de
IA e validação de negócio são informados no job, não como resposta tardia 502
dessa requisição. Resultados são lidos pelos endpoints existentes de análise e
relatório após o job concluir.

### `GET /api/protected/ia-analyze/jobs`

Recupera jobs ativos da empresa autenticada, inclusive após reload/outro dispositivo:

```json
{ "jobs": [{ "id": "uuid", "jobType": "regenerate_insights", "scopeType": "COMPANY", "catalogItemId": null, "phase": "generating", "status": "running", "total": 6, "done": 2, "errorCode": null, "updatedAt": "2026-09-04T12:00:00Z" }] }
```

### `GET /api/protected/ia-analyze/jobs/company-questions/latest`

Retorna o pedido mais recente de geração das 3 perguntas COMPANY da configuração
inicial (`generate_company_questions`), em qualquer status, ou `null` se nunca houve
pedido. Esse job não aparece em `GET /jobs`; a Web usa este endpoint para descobrir
o id e acompanhá-lo por `GET /jobs/:id`.

```json
{ "job": { "id": "uuid", "status": "failed", "errorCode": "invalid_ai_response_schema", "applied": null, "dismissed": false },
  "stillDefault": true }
```

- `applied`: `true` quando as perguntas geradas foram gravadas; `false` quando a
  empresa já tinha editado as perguntas; `null` enquanto o job não termina.
- Com o job ativo (queued, running ou waiting_budget), destrava a fila como o polling
  de `GET /jobs/:id`.
- Em 429 do provedor (`ia_provider_rate_limited`), o job fica em queued e tenta de
  novo após 60s, 120s, 240s e 300s; na quinta falha passa a failed e as perguntas
  padrão permanecem.
- Nunca retorna o contexto enviado nem as sugestões (options).
- `stillDefault`: se as perguntas da empresa ainda são as padrão (`null` sem pedido). Com o pedido `failed`, `stillDefault: true` e `dismissed: false`, a Web mostra o aviso persistente de falha.
- `dismissed`: o gestor escolheu "Manter perguntas padrão" para este pedido (`POST /jobs/company-questions/dismiss`).

### `POST /api/protected/ia-analyze/jobs/company-questions/retry`

"Tentar de novo" a geração das 3 perguntas da configuração inicial **com o modelo atual**, por exemplo depois de uma falha. Sem body. Responde sempre **200** com o que aconteceu (`questionsGeneration`), para a Web mostrar o motivo quando não sai um pedido novo:

```json
{ "questionsGeneration": { "status": "rate_limited", "retryAfterSeconds": 42 } }
```

| `status` | Significado |
|---|---|
| `queued` | Um pedido novo foi para a fila; acompanhe por `GET /jobs/company-questions/latest` |
| `running` | Já havia um pedido ativo; o worker foi acionado |
| `completed` | As perguntas já foram geradas antes |
| `customized` | A empresa já editou as perguntas; a IA não interfere |
| `rate_limited` | Intervalo entre pedidos (`IA_QUESTION_SUGGESTIONS_COOLDOWN_SECONDS`, 60 s) ou limite diário (`IA_QUESTION_SUGGESTIONS_MAX_PER_DAY`, 5); `retryAfterSeconds` diz quanto falta |
| `unavailable` | Contexto incompleto ou IA não configurada; `code` diz qual (`company_context_required`, `ia_config_required`) |

### `POST /api/protected/ia-analyze/jobs/company-questions/dismiss`

"Manter perguntas padrão": dispensa o aviso persistente de falha do **último pedido, se ele falhou** (grava `options.dismissedAt`). Sem body. Vale em qualquer aparelho; um pedido novo (outra tentativa) volta a valer por si.

```json
{ "dismissed": true }
```

`dismissed: false` quando o último pedido não está `failed` (ou não existe).

### `GET /api/protected/ia-analyze/jobs/:id`

Retorna o objeto de status acima, incluindo jobs terminados.

- `phase`: analyzing, generating, synthesizing (a síntese final do relatório, um passo
  por relatório), generating_questions ou diagnosing (diagnóstico do escopo).
- `diagnosisId`: no job do diagnóstico do escopo concluído, o id do resultado; `null` nos demais.
- `done/total`: feedbacks na fase analyzing; nas fases generating e synthesizing,
  passos, com `total` = lotes + uma síntese por relatório.
  Os contadores passam a representar a nova fase quando o job unificado avança.
- `status`: queued, running, waiting_budget, completed ou failed.
- `waiting_budget`: espera automática pela próxima janela de cota.
- `errorCode`: causa da última falha; em queued pode indicar tentativa transitória
  agendada. Só failed é falha terminal.
- `404 ia_job_not_found`: ID inválido/inexistente ou de outra empresa.
- Nunca retorna credenciais, textos do snapshot ou options/checkpoints.

O cliente deve aguardar completed; 202 não comprova conclusão. Perda de conexão
no polling deve reconectar, não declarar falha do job. Operação local e de produção:
[runbook do worker](etapa-03-operacao-worker.md).

### `POST /api/protected/ia-analyze/scope-diagnosis`

**Diagnóstico do escopo com IA.** A IA lê os números do escopo no período, os mesmos das telas, e os compara com o período anterior de mesmo tamanho. Ela devolve o que vai bem, o que preocupa, o que mudou e de 3 a 5 recomendações, sempre com evidência.

**Como funciona:**
- O gateway monta um pacote com estrelas, perguntas atuais (com o peso na nota), tom dos comentários e assuntos, movimento, dias e horários de pico, clientes que voltam e uma amostra de comentários de até 20.
- O pacote vai num job `generate_scope_diagnosis`, que faz uma chamada só ao ia-analyze (`/internal/ia-analyze/diagnose-scope`).

**Body:**
```json
{
  "scope_type": "COMPANY",
  "catalog_item_id": null,
  "start_date": "2026-09-01T03:00:00.000Z",
  "end_date": "2026-10-01T03:00:00.000Z",
  "tz": "America/Sao_Paulo",
  "force": false
}
```
- Período: as mesmas regras de `/feedbacks/stats`. Sem datas, vale o histórico inteiro, e aí não há período anterior para comparar.
- `tz`: o fuso do movimento e dos horários de pico. O padrão é `America/Sao_Paulo`.
- `catalog_item_id`: só vale em escopos de item e precisa ser um item da empresa do mesmo tipo.
- `force: true`: gera de novo mesmo sem dados novos.

**Respostas:**

| Status | Corpo | Quando |
|---|---|---|
| `202` | `{ "jobId", "status", "deduped", "cached": false, "diagnosisId": null }` | Foi para a fila. Acompanhe por `GET /jobs/:id` até `completed` e leia o `diagnosisId` |
| `200` | `{ "jobId": null, "status": "completed", "deduped": false, "cached": true, "diagnosisId" }` | Já existe diagnóstico do mesmo escopo com exatamente os mesmos dados (mesmo hash): não paga IA de novo |

O job é um só por escopo e item. Pedir de novo enquanto um está ativo devolve o mesmo job (`deduped: true`), mesmo com outro período.

**Erros:**
- `400`: `invalid_payload` (escopo ou item inválidos), `invalid_period` ou `invalid_timeline` (fuso).
- `404`: `catalog_item_not_found`.
- `409`: `ia_config_required`. Sem chave e modelo da empresa, nada é calculado.
- `422`: `collecting_data_required_for_analysis` ou `insufficient_feedbacks_for_analysis` (menos de 10 avaliações no período).

**No job:**
- Os erros do provedor seguem a fila: os temporários voltam com espera, e os outros terminam em `failed` com o `errorCode`.
- Os textos dos comentários saem das `options` do job quando ele termina, com sucesso ou com falha definitiva.

### `GET /api/protected/ia-analyze/scope-diagnosis/latest`

Query: `scope_type` e `catalog_item_id`. Devolve o diagnóstico mais recente do escopo, de qualquer período, e o job em andamento, se houver:

```json
{
  "diagnosis": {
    "id": "uuid",
    "scopeType": "COMPANY",
    "catalogItemId": null,
    "period": { "start": "2026-09-01T03:00:00.000Z", "end": "2026-10-01T03:00:00.000Z" },
    "previousPeriod": { "start": "2026-08-02T03:00:00.000Z", "end": "2026-09-01T03:00:00.000Z" },
    "feedbackCount": 42,
    "newFeedbacksSince": 3,
    "model": "modelo/da-empresa",
    "createdAt": "2026-10-02T12:00:00.000Z",
    "result": {
      "summary": "…",
      "going_well": [{ "text": "…", "evidence": "…" }],
      "concerns": [],
      "changes": [],
      "recommendations": [{ "priority": 1, "kind": "fix", "action": "…", "evidence": "…" }],
      "limitations": []
    }
  },
  "job": null
}
```

- `newFeedbacksSince`: avaliações que chegaram no período do diagnóstico depois que ele foi gerado. A Web usa esse número para mostrar quando o diagnóstico ficou velho.
- `job`: o mesmo objeto de `GET /jobs/:id`.
- Os tipos estão em `@feedback/lib-shared` desde a `v1.2.0` (`scope-diagnosis.contract.ts`); o gateway usa a `v1.8.0`.

### `GET /api/protected/ia-analyze/scope-diagnosis`

Histórico do escopo, com os 20 diagnósticos mais recentes, só com o resumo: `{ "items": [{ "id", "period", "feedbackCount", "model", "createdAt", "summary" }] }`.

### `GET /api/protected/ia-analyze/scope-diagnosis/:id`

Um diagnóstico do histórico completo, no mesmo formato de `diagnosis` acima. Com id inválido, inexistente ou de outra empresa, responde `404 scope_diagnosis_not_found`.

---

## Configuração de IA (BYO-key)

Cada empresa pode usar a **própria chave OpenRouter** + modelo. A chave é **cifrada** (AES-256-GCM) no banco e **nunca** volta na resposta.

Todas as rotas desta seção exigem sessão (`credentials: 'include'`) e resolvem a empresa pelo usuário autenticado, nunca pelo body/query. As respostas usam `Cache-Control: private, no-store`.

### `GET /api/protected/user/ia-config`

**Response 200**
```json
{ "hasKey": true, "provider": "openrouter", "model": "openrouter/auto", "keyHint": "xyz9" }
```
> Sem config: `{ "hasKey": false, "provider": null, "model": null, "keyHint": null }`. `keyHint` = últimos 4 caracteres (a chave em si nunca é retornada).
>
> Erros: `404 enterprise_not_found` · `500 internal_server_error`.

### `PUT /api/protected/user/ia-config`

Salva/atualiza a chave. **Valida a chave e o modelo antes de gravar**, consultando `GET https://openrouter.ai/api/v1/models/user?output_modalities=text` com a chave enviada. A escolha deve constar no catálogo compatível da conta (mesmos filtros descritos abaixo). Não realiza geração paga e não comprova saldo disponível.

**Body**
```json
{ "provider": "openrouter", "model": "openrouter/auto", "apiKey": "sk-or-..." }
```

| Campo | Tipo | Obrigatório | Padrão |
|---|---|---|---|
| `provider` | `openrouter` | Não | `openrouter` |
| `model` | `string` (até 120 caracteres; trim) | Não | `openrouter/auto` (também para string vazia) |
| `apiKey` | `string` | Sim | — |

**Response 200** — `{ "hasKey": true, "provider": "openrouter", "model": "openrouter/auto", "keyHint": "1234" }`

Depois de gravar, tenta gerar as perguntas personalizadas da empresa (`autoGenerateCompanyQuestions`), como o `connect`. O resultado não volta na resposta.

**Erros Possíveis**

| Status | Código | Descrição |
|---|---|---|
| `400` | `invalid_payload` | Body fora do schema (ex.: sem `apiKey`) |
| `400` | `ia_config_invalid_key` | Chave reprovada na validação do OpenRouter |
| `400` | `ia_model_unavailable` | Modelo ausente, restrito ou incompatível com o executor |
| `401` | `unauthorized` | Sessão ausente ou inválida |
| `403` | `ia_models_forbidden` | OpenRouter recusou acesso ao catálogo da conta |
| `404` | `enterprise_not_found` | Nenhuma empresa resolvida para o usuário |
| `503` | `ia_models_unavailable` | Não foi possível obter catálogo atualizado; nada foi gravado |
| `500` | `internal_server_error` | Falha ao cifrar/salvar (ex.: `IA_CONFIG_ENCRYPTION_KEY` ausente) |

### `GET /api/protected/user/ia-models`

Catálogo dinâmico para preencher o seletor de modelo no frontend, sem manter uma lista manual.

- Sem chave cadastrada: consulta o catálogo público `GET https://openrouter.ai/api/v1/models?output_modalities=text`, sem token.
- Com chave cadastrada: decifra somente no servidor e consulta `/api/v1/models/user?output_modalities=text`, respeitando as preferências, políticas de privacidade e guardrails da conta OpenRouter.
- Ambos são consultados sem `offset` e `limit` para obter a lista completa. **Não** há fallback do catálogo da conta para o público em caso de erro ou restrição.

**Response 200** (exemplo ilustrativo)

```json
{
  "models": [
    {
      "id": "openrouter/auto",
      "name": "Auto Router",
      "contextLength": null,
      "maxCompletionTokens": null,
      "isAutomatic": true
    }
  ],
  "source": "user",
  "fetchedAt": "2026-09-04T12:00:00.000Z",
  "stale": false,
  "currentModel": "openrouter/auto",
  "currentModelAvailable": true
}
```

`source` é `public` ou `user`. Sem chave, `currentModel` e `currentModelAvailable` são `null`. Se um modelo salvo desaparecer do catálogo, `currentModel` mantém seu ID e `currentModelAvailable` será `false`; o Gateway não troca nem apaga a escolha. Um catálogo válido pode retornar `models: []`.

**Compatibilidade com o executor atual (`ia-analyze`)**

- Entrada e saída devem incluir texto; `supported_parameters` deve incluir `response_format` (o executor pede `json_object`).
- Modelos comuns precisam declarar `max_completion_tokens >= 16384` e `context_length > 16384`, além de não estarem expirados. Modelos com limites desconhecidos são omitidos por segurança.
- `openrouter/auto` aparece primeiro **somente se retornado pelo OpenRouter e aprovado nos filtros de texto/JSON**. Por ser roteamento automático, admite limites desconhecidos; limites explícitos insuficientes continuam sendo rejeitados. Os limites efetivos dependem do destino escolhido pelo roteador.
- Os metadados reduzem incompatibilidades, mas não garantem disponibilidade, saldo, qualidade da análise nem que qualquer prompt caiba na janela de contexto. Se o orçamento de saída do executor mudar, atualizar o filtro `REQUIRED_OUTPUT_TOKENS` no Gateway.

**Cache e falhas**

Cache em memória por instância, TTL de 5 minutos e máximo de 100 entradas. Catálogos autenticados são separados por empresa e hash da chave; não se usa o token puro como chave de cache. PUT/DELETE bem-sucedidos invalidam as entradas da empresa na instância atual. O cache não é distribuído entre instâncias Vercel.

Cada consulta ao provedor tem timeout de 8 segundos. Em erro transitório (rede, timeout, 429, 5xx ou resposta malformada), a leitura pode retornar o último catálogo com menos de 30 minutos de idade, marcado `stale: true` e mantendo o `fetchedAt` original. Sem cache utilizável retorna `503 ia_models_unavailable`. Falhas 401/403 do provedor invalidam a entrada e não usam stale: retornam respectivamente `400 ia_config_invalid_key` e `403 ia_models_forbidden`. O 401 da API fica reservado à sessão do aplicativo. Respostas de erro nunca incluem headers, corpo do provedor ou credenciais.

Também pode retornar `404 enterprise_not_found`, `409 ia_config_required` (configuração legada de outro provedor) ou `500 internal_server_error` (falha de banco/decifra).

### `PATCH /api/protected/user/ia-config/model`

Altera **somente o modelo**, utilizando a chave já cadastrada. Não requer reenviar token, não recifra a chave e não faz upsert. `provider`, chave cifrada/IV/tag e `keyHint` permanecem intactos.

**Body** — somente este campo; campos extras são rejeitados.

```json
{ "model": "openrouter/auto" }
```

`model` é obrigatório, não vazio, com até 120 caracteres após trim. O Gateway consulta um catálogo atualizado da conta antes de gravar (inclusive no PUT): ignora cache recente e **nunca aceita stale para autorizar a escolha**. Consultas simultâneas para a mesma empresa/chave podem compartilhar uma requisição em andamento.

**Response 200**

```json
{ "hasKey": true, "provider": "openrouter", "model": "openrouter/auto", "keyHint": "xyz9",
  "questionsGeneration": { "status": "queued" } }
```

`questionsGeneration` diz se a troca disparou uma nova geração das perguntas da configuração inicial; os valores são os mesmos de `POST /ia-analyze/jobs/company-questions/retry`.

Além dos erros de validação/autenticação/catálogo do PUT:

| Status | Código | Descrição |
|---|---|---|
| `409` | `ia_config_required` | Não há chave OpenRouter cadastrada; é necessário usar PUT primeiro |
| `409` | `ia_config_changed` | Configuração foi removida ou alterada durante a operação; recarregar antes de tentar novamente |

O UPDATE exige a mesma empresa, ID da configuração, chave cifrada/IV/tag e modelo lidos antes da validação externa. Isso impede que a operação sobrescreva uma troca concorrente ou recrie uma configuração removida. Em qualquer falha, a configuração anterior é preservada.

**Efeito imediato nos jobs em espera.** Depois de gravar o modelo (e antes de tentar de novo a geração automática das perguntas), o Gateway antecipa para agora o `next_run_at` dos jobs de IA da empresa em `queued` ou `waiting_budget` agendados para o futuro (ex.: backoff de 429, até 300 s) e dispara um passo do worker (`kickWorkerIfPending`). Como o job resolve as credenciais a cada tentativa, a próxima já usa o modelo novo — a Web pode trocar o modelo pela tela de espera ("Preparando sua conta"/análises) sem sair dela. Jobs `running` não são alterados (pertencem a um worker com lease); se a troca falhar (`409`), nada é antecipado.

### `POST /api/protected/user/ia-config/openrouter/connect`

**"Conectar com OpenRouter" (OAuth PKCE).** Funciona assim:

1. A Web manda a pessoa para `https://openrouter.ai/auth`, com o `callback_url` e o `code_challenge` (S256).
2. O OpenRouter devolve um `code` à Web.
3. A Web envia o `code` e o verificador para cá.
4. Aqui, o código é trocado pela chave em `POST https://openrouter.ai/api/v1/auth/keys`. A chave **nunca passa pelo navegador**: é validada em `/models/user`, cifrada e salva, como no `PUT`.

**Body:**
```json
{ "code": "…", "codeVerifier": "43 a 128 caracteres [A-Za-z0-9._~-]", "model": "opcional" }
```

- **Modelo salvo:** o `model` pedido, se a conta tem acesso a ele. Senão, o que já estava salvo. Senão, `openrouter/free` (o roteador que só usa modelos gratuitos). Senão, o primeiro modelo `:free`.
- **Resposta:** a mesma do `PUT`, sem a chave: `{ hasKey, provider, model, keyHint }`. Também dispara a geração das perguntas personalizadas.
- **Erros:**
  - `400 invalid_payload`;
  - `400 openrouter_connect_failed`: código vencido, já usado ou verificador errado; a pessoa conecta de novo;
  - `502` ou `503 openrouter_connect_failed`: o OpenRouter não respondeu;
  - os mesmos erros de validação da chave do `PUT`.

---

### `DELETE /api/protected/user/ia-config`

Remove a config. As análises ficam bloqueadas com `ia_config_required` até uma nova chave ser configurada. **Response 200** — `{ "hasKey": false, "provider": null, "model": null, "keyHint": null }`.

**Integração do frontend (próxima etapa):** carregar `ia-models` para preencher o select; usar PUT no cadastro inicial e PATCH para trocar modelo com chave já salva. Preservar a seleção atual ausente do catálogo com aviso, informar `stale` e tratar catálogo vazio/erro. Não oferecer um modelo removido como nova escolha nem enviar token no PATCH. Nenhuma migration ou variável de ambiente nova é necessária nesta etapa.

Referências: [catálogo público OpenRouter](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties), [catálogo filtrado por conta](https://openrouter.ai/docs/api/api-reference/models/list-models-filtered-by-user-provider-preferences-privacy-settings-and-guardrails).

---

## Interno (token, não sessão)

### `POST /api/internal/worker/tick`

Drena a fila de análise (etapa 03): processa um lote de jobs e volta. **Não** usa sessão — protegido pelo `WORKER_TICK_TOKEN` (header `x-worker-token`), chamado pelo workflow `ia-worker.yml` do GitHub Actions a cada 5 minutos (reserva; a fila também anda pelo `kickWorker` quando um job é criado). Ver [operação do worker](./etapa-03-operacao-worker.md).

**Response 200** — `{ "processed": 2, "results": [ ... ] }`

**Response 401** `unauthorized_worker_request` — header `x-worker-token` ausente ou diferente do `WORKER_TICK_TOKEN`. Sem `WORKER_TICK_TOKEN` no ambiente, a rota só fica liberada fora de produção e fora da Vercel; com `NODE_ENV=production` ou `VERCEL=1`, sem token, responde sempre `401`.

**Response 500** `internal_server_error` — falha ao drenar a fila.

---

## Autenticação (Pública)

Endpoints sem autenticação. A sessão é gerenciada por **cookie HttpOnly** (use `credentials: 'include'`).

### `POST /api/public/auth/login`

Autentica e cria a sessão (cookie).

**Body**
```json
{ "email": "gestor@empresa.com", "password": "senha123", "remember": true }
```

**Response 200**
```json
{ "ok": true, "user": { "id": "uuid", "email": "gestor@empresa.com" } }
```

**Erros Possíveis**

| Status | Código | Descrição |
|---|---|---|
| `400` | `invalid_payload` | Dados de login inválidos |
| `401` | `invalid_credentials` | E-mail ou senha incorretos **— também retornado quando o e-mail não foi confirmado (RNE-014, anti-enumeração)** |
| `401` | `login_failed` | Falha genérica de login (fallback) |
| `429` | `rate_limited` | Muitas tentativas em pouco tempo |
| `503` | `service_unavailable` | Serviço de login indisponível |
| `500` | `internal_error` | Exceção não tratada |

---

### `POST /api/public/auth/logout`

Invalida a sessão no servidor (limpa o cookie).

**Response 204** — sem corpo.

---

### `POST /api/public/auth/register`

Cria uma nova conta. Por segurança (RNE-014), e-mail já cadastrado **não** é revelado: a resposta é a mesma de sucesso.

**Body**
```json
{
  "fullName": "Padaria Bom Pão",
  "email": "maria@empresa.com",
  "phone": "+5511999990000",
  "password": "sol azul de manha",
  "confirmPassword": "sol azul de manha",
  "terms": true
}
```

- `fullName` é o **nome do negócio**, para pessoa física ou jurídica.
- **Senha:** pelo menos 10 caracteres (`MIN_PASSWORD_LENGTH`) e nota 4 no zxcvbn, com dicionário em português (`MIN_PASSWORD_SCORE`). A mesma regra vale na Web e na redefinição de senha.
  - O zxcvbn reconhece palavras comuns, nomes, sequências e repetições. "Palavra123palavra" não passa; uma frase curta ("sol azul de manha") passa.
  - O nome do negócio, o e-mail e o telefone dentro da senha derrubam a nota.

**Response 200**
```json
{ "ok": true, "message": "confirmation_required" }
```

**Erros Possíveis**

| Status | Código | Descrição |
|---|---|---|
| `400` | `invalid_payload` | Dados de cadastro inválidos |
| `400` | `password_too_weak` | Senha fácil de adivinhar (nota abaixo de 4 no zxcvbn) |
| `400` | `database_error` | Falha ao salvar o novo usuário |
| `409` | `phone_taken` | Telefone já cadastrado |
| `400` | `signup_failed` | Falha de cadastro (e-mail/senha inválidos, captcha ou erro genérico) |
| `429` | `signup_failed` | Muitas tentativas (rate limit) |
| `503` | `signup_failed` | Cadastro temporariamente indisponível — Better Auth respondeu 5xx (inclui falha ao enviar o e-mail de confirmação) |
| `500` | `internal_error` | Exceção não tratada |

> O e-mail duplicado **não** gera erro — retorna `200 confirmation_required` (anti-enumeração).

**Ordem de escrita no cadastro.** A força da senha é conferida primeiro; as pré-checagens (telefone, e-mail) são apenas leitura. Em caso de sucesso, as tabelas são preenchidas nesta ordem:

1. `public.user` — o usuário (Better Auth)
2. `public.account` — credencial + hash de senha (provider `credential`)
3. `public.verification` — token do e-mail de confirmação
4. `public.enterprise` — empresa do gestor (trial de 4 meses, `TRIAL`)
5. `public.questions_of_feedbacks` — as 3 perguntas COMPANY padrão

Os passos 1–3 são do `signUpEmail` do Better Auth; os 4–5 são o provisionamento da empresa (`provisionEnterpriseForUser`), numa transação Drizzle própria.

---

### `POST /api/public/auth/forgot-password`

Solicita o e-mail de redefinição de senha. A resposta é sempre genérica (não revela se o e-mail existe).

**Body**
```json
{ "email": "gestor@empresa.com" }
```

**Response 200**
```json
{ "ok": true, "message": "Se este e-mail estiver cadastrado, você receberá as instruções em breve." }
```

> A resposta é genérica quanto à **existência** do e-mail (anti-enumeração). Ainda assim, um body malformado retorna **`400 invalid_payload`** — o `email` precisa ser um e-mail válido.

---

### `POST /api/public/auth/resend-confirmation`

Reenvia o e-mail de confirmação de cadastro. A resposta é sempre a mesma, exista ou não uma conta pendente para o e-mail (anti-enumeração): falhas do envio são só registradas no log. As respostas usam `Cache-Control: no-store`.

O mesmo controller atende `POST /api/auth/send-verification-email`, montado antes do handler do Better Auth, para que a rota nativa também passe pelo limite de reenvio.

**Body**
```json
{ "email": "gestor@empresa.com" }
```

**Response 200**
```json
{ "ok": true, "message": "Se existir uma conta pendente para este e-mail, enviaremos uma nova confirmação.", "retryAfterSeconds": 60 }
```

`retryAfterSeconds` é o intervalo até o próximo reenvio permitido para o e-mail.

**Limite de reenvio** (contadores na tabela `auth_rate_limit`, com IP e e-mail guardados como HMAC):

| Limite | Padrão | Variável |
|---|---|---|
| Intervalo entre reenvios do mesmo e-mail | 60 s | `RESEND_EMAIL_COOLDOWN_SECONDS` |
| Por e-mail | 5 por hora | `RESEND_EMAIL_MAX` / `RESEND_EMAIL_WINDOW_SECONDS` |
| Por IP | 20 a cada 15 min | `RESEND_IP_MAX` / `RESEND_IP_WINDOW_SECONDS` |

**Erros Possíveis**

| Status | Código | Descrição |
|---|---|---|
| `400` | `invalid_payload` | E-mail ausente ou inválido no body |
| `429` | `rate_limited` | Limite de reenvio atingido; vem com `retryAfterSeconds` no corpo e o header `Retry-After` |
| `503` | `service_unavailable` | Controle de reenvio indisponível (banco, IP do cliente ou segredo do HMAC) |

---

### `GET /api/public/auth/callback`

Processa o link de recuperação de senha e **redireciona** o navegador. Não retorna JSON. É o `redirectTo` que o `POST /public/auth/forgot-password` passa ao Better Auth (`?type=recovery&next=/auth/reset-password`). A confirmação de cadastro e a troca de e-mail **não** passam por aqui: o link desses e-mails vai direto ao `/api/auth/verify-email` do Better Auth, que redireciona para a Web.

**Query Params**

| Parâmetro | Descrição |
|---|---|
| `type` | `recovery`; qualquer outro valor cai no redirecionamento genérico |
| `token_hash` / `token` | Token do link |
| `next` | Caminho de destino após sucesso (padrão `/user/dashboard`; valor que não começa com `/` vira o padrão) |

**Redirecionamentos**
- Recuperação de senha (`type=recovery` com token) → grava o token no cookie HttpOnly `ba_reset` (1 h, `path=/api/protected/user/password`) e vai **direto** para `<web><next>` (ex.: `/auth/reset-password`), **sem** passar por `/auth/success`.
- Demais casos → `<web>/auth/success?next=<destino>`.

> O gateway **não** tem um redirect próprio para link inválido/expirado (não existe `/auth/link-expired`). A validação do token acontece na etapa seguinte — ex.: no `PATCH /user/password`, que retorna `reset_password_invalid_token` quando o link de recuperação está expirado/ inválido.

---

## QR Code (Público)

### `GET /api/public/enterprise/:id`

Retorna os dados públicos de uma empresa **e as perguntas do escopo** para montar o formulário de feedback antes do envio.

**Query Params (opcionais)**

| Parâmetro | Tipo | Descrição |
|---|---|---|
| `collection_point` | `string` | ID do ponto de coleta (resolve o escopo/item) |
| `catalog_item` | `string` | ID do item de catálogo (alternativa ao ponto de coleta) |

> O backend retorna **exatamente** as perguntas ativas configuradas para o escopo resolvido (0 a 3) — **nunca** faz fallback para o escopo `COMPANY`. Quando não há perguntas ativas, `questions` vem vazio (o formulário exibe apenas nota + mensagem).

**Response 200**
```json
{
  "id": "uuid",
  "name": "Empresa Exemplo",
  "collection_point_id": "uuid | null",
  "catalog_item_id": "uuid | null",
  "item_name": "Produto X | null",
  "item_kind": "PRODUCT | SERVICE | DEPARTMENT | null",
  "questions": [
    {
      "id": "uuid",
      "scope_type": "PRODUCT",
      "catalog_item_id": "uuid | null",
      "question_order": 1,
      "question_text": "Como você avalia o atendimento?",
      "subquestions": []
    }
  ],
  "comment": { "mode": "DEFAULT | CUSTOM | HIDDEN", "prompt": "string | null" }
}
```

> `comment` é o campo de comentário do escopo (ver `PUT /api/protected/user/collection-points/comment-field`). Sem conseguir lê-lo, vem o convite padrão.
>
> Os campos `full_name` e `status` **não** são retornados por este endpoint. A leitura é feita da view `enterprise_public` (apenas `id` e `name`).

**Response 404** `enterprise_not_found` — empresa inexistente.

---

### `POST /api/public/qrcode/feedback`

Submete um feedback via formulário público. Não requer autenticação. O `device_fingerprint` **não** é enviado pelo cliente — é calculado no backend como `MD5(userAgent | clientIP | dayEpoch)`.

**Body**
```json
{
  "enterprise_id": "uuid",
  "channel": "NFC",
  "rating": 5,
  "message": "Ótimo atendimento!",
  "answers": [
    { "question_id": "uuid", "answer_value": "OTIMA" },
    { "question_id": "uuid", "answer_value": "BOA" },
    { "question_id": "uuid", "answer_value": "MEDIANA" }
  ],
  "subanswers": [
    { "subquestion_id": "uuid", "answer_value": "BOA" }
  ],
  "collection_point_id": "uuid (opcional)",
  "catalog_item_id": "uuid (opcional)",
  "customer_name": "Maria (opcional)",
  "customer_email": "maria@exemplo.com (opcional)"
}
```

| Campo | Tipo | Obrigatório | Observação |
|---|---|---|---|
| `enterprise_id` | `string (UUID)` | Sim | — |
| `channel` | `string` | Não | Canal de coleta, vindo da marca `canal` da URL do formulário: `QR`, `LINK`, `NFC` ou `TEST` (o "Testar o formulário"). Valor ausente, desconhecido ou o antigo `QRCODE` grava `null` (não identificado), sem recusar a resposta |
| `rating` | `number` | Sim | inteiro de 1 a 5 |
| `message` | `string` | Não | Comentário opcional, até 5000 caracteres (vazio ou ausente = só as estrelas e as respostas). Sem comentário, o feedback não vai para a IA nem conta como "aguardando análise". Com o campo oculto no escopo, o texto é descartado. Com pergunta própria, a pergunta é guardada com o comentário (`feedback.comment_prompt`) e vai à IA na análise |
| `answers` | `array` | Sim | contagem variável (0 a 3), igual ao número de perguntas ativas do escopo; `answer_value` ∈ `PESSIMO\|RUIM\|MEDIANA\|BOA\|OTIMA` |
| `subanswers` | `array` | Não | deve cobrir **todas** as subperguntas ativas (máx. 9) |
| `collection_point_id` / `catalog_item_id` | `string (UUID)` | Não | resolvem o escopo |
| `customer_*` | vários | Não | dados opcionais de quem respondeu. O schema aceita `customer_name`, `customer_email`, `customer_phone`, `customer_birth_date`, `customer_gender`, `customer_city`, `customer_state` e `customer_country`, mas só nome, e-mail e gênero são gravados (no cadastro do cliente, deduplicado por e-mail) |

**Response 200**
```json
{ "ok": true }
```

**Response 400** `invalid_payload` — payload fora do schema, contagem de respostas incorreta ou `answer_score = 0`.

**Response 404** `enterprise_not_found` / `collection_point_not_found` (sem ponto de coleta QR **ativo** para o escopo).

**Response 409** `DEVICE_ALREADY_SUBMITTED` — dispositivo já enviou feedback para este ponto de coleta hoje (anti-spam diário).

**Response 403** `DEVICE_BLOCKED` — o registro do aparelho na empresa está com `is_blocked = true`. Como o fingerprint inclui o dia, o bloqueio vale para o registro daquele dia.

**Response 500** `collection_point_error` · `device_check_failed` · `device_creation_failed` · `feedback_insert_failed` — falha de banco; nada é gravado.

---

## Troubleshooting Geral

| Sintoma | Causa Provável | O Que Verificar |
|---|---|---|
| `401` em qualquer endpoint protegido | Sessão expirada ou ausente | Refaça o login; garanta que as requisições vão com `credentials: 'include'` (a sessão é cookie HttpOnly — **não** há header `Authorization`) |
| `collecting_data_required_for_analysis` (`422` no diagnóstico do escopo; no `errorCode` do job nas análises) | Empresa sem dados de contexto | Preencha os três campos obrigatórios (`company_objective`, `analytics_goal` e `business_summary`) em Configurações da empresa |
| `insufficient_feedbacks_for_analysis` (`422` ou no job) | Base de feedbacks pequena | Colete pelo menos 10 feedbacks antes de analisar |
| Job de IA `failed` com `failed_remote_ia_analyze_request` ou `ia_provider_*` | Serviço `ia-analyze` offline ou provedor LLM com erro. Os POSTs de IA só enfileiram e não devolvem `502` | Verifique se o `ia-analyze` está rodando e se `IA_ANALYZE_REMOTE_URL`/`IA_ANALYZE_REMOTE_TOKEN` estão configurados. A chave do LLM é a **da empresa** (`/user/ia-config`); sem ela, o job falha com `ia_config_required`. A chave global do `ia-analyze` só entra com `REQUIRE_USER_IA_KEY=false` |
| `400 ia_config_invalid_key` no `PUT /user/ia-config` | Chave OpenRouter inválida | Confira/gere a chave em https://openrouter.ai/keys |
| Job assíncrono fica `failed` | Erro capturado no worker | Veja `errorCode` no `GET /ia-analyze/jobs/:id` (ex.: `ia_config_required`, `insufficient_feedbacks_for_analysis`) e confirme que o cron está batendo em `/internal/worker/tick` |
| `409` no POST público | Fingerprint já registrado hoje neste ponto de coleta | Aguarde até o próximo dia ou use outro ponto de coleta |
| `403` no POST público | Registro do aparelho bloqueado | Registro em `tracked_devices` marcado como `is_blocked` — requer intervenção manual |
