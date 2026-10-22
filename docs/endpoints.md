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

Inicia a troca de e-mail. O Better Auth envia um link de confirmação para o novo endereço; a mudança só é efetivada após o callback.

**Body**
```json
{ "email": "novo@empresa.com" }
```

**Response 200**
```json
{ "user": { "id": "uuid", "email": "novo@empresa.com" } }
```

**Response 400** `invalid_payload` / `update_failed`.

---

### `PATCH /api/protected/user/metadados`

Atualiza metadados do usuário (ex.: `full_name`).

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

- `fullName` é o nome do negócio e vai para `user.name`; `phone` vai para `user.phone`.
- O aceite (`terms_version: v1` e a data) vai para a empresa. A empresa também é criada aqui, se ainda não existir.
- **Respostas:**
  - `200 { ok: true }`;
  - `400 invalid_payload`;
  - `409 phone_taken`: o telefone é de outra conta.
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

Redefine a senha do usuário. Usado na etapa final do fluxo "Esqueci minha senha", com a sessão temporária estabelecida pelo callback de recuperação.

**Body**
```json
{ "password": "novaSenha123", "confirmPassword": "novaSenha123" }
```

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

---

### `PATCH /api/protected/user/enterprise`

Atualiza dados cadastrais parciais da empresa (versão e aceite dos termos).

**Body (todos os campos são opcionais)**
```json
{
  "terms_version": "v2",
  "terms_accepted_at": "2026-05-24T10:00:00Z"
}
```

> O CPF/CNPJ não é mais pedido nem guardado (migration `0009`): o sistema não usa esse dado (LGPD, necessidade).

**Response 200** — mesmo formato de `GET /enterprise`.

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

---

### `PATCH /api/protected/user/collecting_data`

Atualiza parcialmente as configurações de coleta. **Response 200** — mesmo formato de `GET` (objeto `collecting`).

### `PUT /api/protected/user/collecting_data`

Upsert completo (cria se não existir, substitui se existir). **Response 200** — mesmo formato de `GET` (objeto `collecting`).

---

## Feedbacks

### `GET /api/protected/user/feedbacks`

Lista todos os feedbacks da empresa com paginação e filtros.

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
      "created_at": "2026-05-12T12:00:00Z",
      "collection_points": {
        "id": "uuid",
        "name": "Caixa Principal",
        "type": "QR_CODE",
        "identifier": "uuid | null",
        "catalog_item_id": "uuid | null",
        "catalog_item_name": null,
        "catalog_item_kind": null,
        "catalog_items": null
      },
      "feedback_question_answers": []
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

`commentParticipation` diz quantos escreveram comentário (`withComment`, `pct`) e quantos desses comentários são curtos, com menos de 20 caracteres (`shortComments`). `commentField` diz como está o campo de comentário nos pontos de coleta do recorte: `hidden` ∈ `all` · `some` · `none` e `prompt` (a pergunta própria, quando o recorte é um ponto só). A Web usa os dois para sugerir mudar o campo, pela mesma regra que vai ao diagnóstico da IA.

`totalAnalyzed`/`pendingCount` indicam quantos feedbacks do escopo já têm análise da IA e quantos faltam (`totalFeedbacks − totalAnalyzed`); `latestAnalysisAt` é o timestamp ISO da análise mais recente (ou `null`).

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

- **Quem é o cliente:** o aparelho identificado pelo anti-spam (`tracked_device_id`). Por isso o número é aproximado, e a resposta não traz nenhum dado pessoal.
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
| `returningPct` | % de `returningCount` sobre `identified`, com o IC de Wilson em `returningPctCI` |
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

> Quando não há relatório gerado ainda, retorna `summary: null` e `recommendations: []`.

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

---

### `POST /api/protected/user/collection-points/qr/enable`

Ativa (ou cria) o ponto de coleta de QR Code da empresa.

**Response 200**
```json
{ "id": "uuid", "active": true }
```

---

### `POST /api/protected/user/collection-points/qr/disable`

Desativa o ponto de coleta de QR Code da empresa.

**Response 200**
```json
{ "active": false }
```

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

**Response 400** `collection_point_error` — `kind` inválido ou ausente.

---

### `POST /api/protected/user/collection-points/qr/catalog/questions/upsert`

Cria/atualiza as perguntas dinâmicas de um item de catálogo. O array `questions` deve conter **sempre os 3 slots** (`question_order` 1, 2 e 3); desses, **1 a 3 podem ter texto** (20–150 caracteres cada) e os demais ficam vazios. Cada slot aceita até 3 subperguntas. Esvaziar um slot faz **soft-delete** (`is_active = false`), preservando o histórico de respostas; o editor lê apenas registros `is_active = true`.

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

**Response 400** `invalid_payload` — o array `questions` não tem os 3 slots (`questions_must_have_3_slots`) ou o texto está fora de 20–150 caracteres.

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

- `phase`: analyzing, generating, generating_questions ou diagnosing (diagnóstico do escopo).
- `diagnosisId`: no job do diagnóstico do escopo concluído, o id do resultado; `null` nos demais.
- `done/total`: feedbacks na fase analyzing; lotes na fase generating.
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
| `200` | `{ "jobId": null, "status": "completed", "cached": true, "diagnosisId" }` | Já existe diagnóstico do mesmo escopo com exatamente os mesmos dados (mesmo hash): não paga IA de novo |

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
- Os tipos estão em `@feedback/lib-shared` `v1.2.0` (`scope-diagnosis.contract.ts`).

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

Drena a fila de análise (etapa 03): processa um lote de jobs e volta. **Não** usa sessão — protegido pelo `WORKER_TICK_TOKEN` (header `x-worker-token`), chamado por um **cron externo** (~1 min). Ver [operação do worker](./etapa-03-operacao-worker.md).

**Response 200** — `{ "processed": 2, "results": [ ... ] }`

**Response 401** `unauthorized_worker_request` — token ausente/incorreto (quando `WORKER_TICK_TOKEN` está setado).

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

> O e-mail duplicado **não** gera erro — retorna `200 confirmation_required` (anti-enumeração).

**Ordem de escrita no cadastro.** As pré-checagens (telefone, documento, e-mail) são apenas leitura. Em caso de sucesso, as tabelas são preenchidas nesta ordem:

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

Reenvia o e-mail de confirmação de cadastro.

**Body**
```json
{ "email": "gestor@empresa.com" }
```

**Response 200**
```json
{ "ok": true, "message": "E-mail de confirmação reenviado com sucesso." }
```

**Erros Possíveis**

| Status | Código | Descrição |
|---|---|---|
| `400` | `invalid_payload` | E-mail ausente ou inválido no body |
| `400` | `resend_failed` | Falha ao reenviar o e-mail de confirmação |
| `429` | `rate_limited` | Muitas solicitações de reenvio |
| `503` | `service_unavailable` | Serviço de e-mail temporariamente indisponível |
| `500` | `internal_error` | Exceção não tratada |

---

### `GET /api/public/auth/callback`

Processa o link clicado no e-mail (confirmação de cadastro, troca de e-mail ou recuperação de senha) e **redireciona** o navegador. Não retorna JSON.

**Query Params**

| Parâmetro | Descrição |
|---|---|
| `type` | `recovery` / `email_change` / (vazio = signup) |
| `token_hash` / `token` | Token do link |
| `next` | Caminho de destino após sucesso (padrão `/user/dashboard`) |

**Redirecionamentos**
- Recuperação de senha (`type=recovery` com token) → vai **direto** para `<web>/<next>` (ex.: `/auth/reset-password`), **sem** passar por `/auth/success`.
- Demais casos (signup / `email_change`) → `<web>/auth/success?next=<destino>`.

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
  "channel": "QRCODE",
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
| `channel` | `"QRCODE"` | Sim | literal |
| `rating` | `number` | Sim | inteiro de 1 a 5 |
| `message` | `string` | Não | Comentário opcional, até 5000 caracteres (vazio ou ausente = só as estrelas e as respostas). Sem comentário, o feedback não vai para a IA nem conta como "aguardando análise". Com o campo oculto no escopo, o texto é descartado. Com pergunta própria, a pergunta é guardada com o comentário (`feedback.comment_prompt`) e vai à IA na análise |
| `answers` | `array` | Sim | contagem variável (0 a 3), igual ao número de perguntas ativas do escopo; `answer_value` ∈ `PESSIMO\|RUIM\|MEDIANA\|BOA\|OTIMA` |
| `subanswers` | `array` | Não | deve cobrir **todas** as subperguntas ativas (máx. 9) |
| `collection_point_id` / `catalog_item_id` | `string (UUID)` | Não | resolvem o escopo |
| `customer_*` | vários | Não | dados opcionais de quem respondeu |

**Response 200**
```json
{ "ok": true }
```

**Response 400** `invalid_payload` — payload fora do schema, contagem de respostas incorreta ou `answer_score = 0`.

**Response 404** `enterprise_not_found` / `collection_point_not_found`.

**Response 409** `DEVICE_ALREADY_SUBMITTED` — dispositivo já enviou feedback para este ponto de coleta hoje (anti-spam diário).

**Response 403** `DEVICE_BLOCKED` — dispositivo permanentemente bloqueado (`is_blocked = true`).

---

## Troubleshooting Geral

| Sintoma | Causa Provável | O Que Verificar |
|---|---|---|
| `401` em qualquer endpoint protegido | Sessão expirada ou ausente | Refaça o login; garanta que as requisições vão com `credentials: 'include'` (a sessão é cookie HttpOnly — **não** há header `Authorization`) |
| `422 collecting_data_required` | Empresa sem dados de contexto | Preencha os três campos obrigatórios (`company_objective`, `analytics_goal` e `business_summary`) em Configurações da empresa |
| `422 insufficient_feedbacks_for_analysis` | Base de feedbacks pequena | Colete pelo menos 10 feedbacks antes de analisar |
| `502` nos endpoints de IA | Serviço `ia-analyze` offline ou provedor LLM com erro | Verifique se o `ia-analyze` está rodando e se `IA_ANALYZE_REMOTE_URL`/`IA_ANALYZE_REMOTE_TOKEN` estão configurados. A chave do LLM é a **da empresa** (se configurada em `/user/ia-config`) ou a global do `ia-analyze` (`GEMINI_API_KEY`/`OPENROUTER_API_KEY`) |
| `400 ia_config_invalid_key` no `PUT /user/ia-config` | Chave OpenRouter inválida | Confira/gere a chave em https://openrouter.ai/keys |
| Job assíncrono fica `failed` | Erro capturado no worker | Veja `errorCode` no `GET /ia-analyze/jobs/:id` (ex.: `ia_config_required`, `insufficient_feedbacks_for_analysis`) e confirme que o cron está batendo em `/internal/worker/tick` |
| `409` no POST público | Fingerprint já registrado hoje neste ponto de coleta | Aguarde até o próximo dia ou use outro ponto de coleta |
| `403` no POST público | Dispositivo permanentemente bloqueado | Dispositivo marcado como `is_blocked` — requer intervenção manual |
