# Backend (API Gateway) — Arquitetura e Estrutura 

O backend utiliza uma combinação de padrões arquiteturais para garantir segurança, organização e escalabilidade.
Podemos dividir a arquitetura em duas visões:

- **Visão Macro:** Como o backend se encaixa no sistema inteiro
- **Visão Micro:** Como o código está organizado por dentro

## Visão Macro: API Gateway e BFF (Backend-For-Frontend)

O backend principal (o `api-gateway`) atua como um **Backend-for-Frontend (BFF)**. Isso significa que ele é o **único ponto de entrada** para o Frontend. O Frontend nunca acessa o banco de dados diretamente nem fala com serviços externos, tudo passa pelo *Gateway*.

Ele segue uma topologia **Hub-and-Spoke**, onde o API Gateway é o centro (hub) que orquestra a comunicação com:

- O banco de dados (Supabase / PostgreSQL).
- O serviço de autenticação (**Better Auth**, embutido no próprio gateway, com entrada pelo Google).
- O serviço Serverless `ia-analyze`, que faz as chamadas ao LLM.
- A API do OpenRouter, só para a configuração de IA da empresa (trocar o código do "Conectar com OpenRouter" pela chave, validar a chave e listar os modelos).
- O servidor SMTP dos e-mails transacionais (nodemailer).

**Vantagens disso:** Centraliza a validação de segurança (sessão via cookie httpOnly) e isola lógicas complexas, deixando o Frontend mais leve.

## Visão Micro: Arquitetura em Camadas (Layered Architecture)

Internamente, o API Gateway adota uma **Arquitetura em Camadas** como padrão de referência. O fluxo ideal segue um caminho de *ida e volta* entre as camadas:

1. **Rotas (`routes/`):** A porta de entrada. Recebem a requisição HTTP e direcionam para o controller correto.
2. **Middlewares (`middlewares/`):** A segurança. Validam a autenticação (o `requireAuth` valida a sessão via Better Auth) antes de deixar a requisição prosseguir, injetando `req.user` e `req.enterpriseId` na request.
3. **Controllers (`controllers/`):** Os "gerentes". Recebem a requisição validada, extraem os parâmetros ou o corpo (body) e resolvem a resposta.
4. **Services (`services/`):** O "cérebro". Concentram as regras de negócio mais complexas, validam requisitos (ex: verificar se há feedbacks suficientes para analisar) e orquestram o fluxo de dados.
5. **Repositories (`repositories/`):** Os "arquivistas". Encapsulam as queries ao banco de dados via **Drizzle** (`DATABASE_URL`). O app entra com o papel `feedback_app`, que só lê e escreve dados, e a policy da RLS deixa esse papel ver todas as linhas ([banco com o mínimo de privilégio](./banco-menor-privilegio.md)); por isso o isolamento por `enterprise_id` é forçado na aplicação (`src/db/tenantScope.ts`), e a RLS barra os outros papéis do Supabase. Ver [Migrations (Drizzle)](./migrations-drizzle.md).

> **Estado atual da implementação:** o padrão **completo** Controller → Service → Repository existe nos fluxos de IA e de métricas: **análise e relatório** (`iaAnalyze.service.ts` + `insightsJob.service.ts`), **diagnóstico do escopo** (`scopeDiagnosis.service.ts`), **perguntas da empresa geradas pela IA** (`companyQuestionSuggestions.service.ts` + `companyQuestionsAutoGenerate.service.ts`), **configuração de IA** (`iaConfig.service.ts`) e **métricas do escopo** (`scopeMetrics.service.ts` + `questionMetrics.service.ts`, usados pelas rotas de feedbacks e pelo diagnóstico). Vários fluxos usam **Controller → Repository** (sem Service): os **pontos de coleta/QR** (`collectionPointsQr.repository.ts`), o **campo de comentário** (`commentField.repository.ts`), o **formulário público** (`publicEnterprise`, `publicQuestions` e `qrFeedback`), a **empresa e a coleta** (`collectingData.repository.ts` + `enterprise.repository.ts`) e o **guia do sistema** (`onboarding.repository.ts`). **Usuário/autenticação/cadastro** usam o **Better Auth** (`getAuth().api.*`), mas ainda há SQL direto no controller em três pontos: nome e telefone (`user.controller.ts`), as checagens de telefone e e-mail do cadastro (`register.controller.ts`) e o completar cadastro de quem entra com o Google (`completeSignup.controller.ts`). Migrar esses pontos para o padrão em camadas é um trabalho em aberto.

Há também pastas de apoio estrutural, como a `libs/`, com a lógica de domínio que não é rota nem acesso a dados. A maior parte é pura (estatística, período, movimento no tempo, pico, clientes, canal, participação nos comentários, montagem dos lotes e do pacote do diagnóstico); as exceções são `libs/iaJob/` (o worker e o limitador de ritmo, que usam o banco), `libs/iaConfig/` (resolve e decifra a chave da empresa e fala com a API do OpenRouter) e `libs/resendRateLimit.ts`. Os `providers/` fazem a comunicação HTTP com o `ia-analyze`.

### Mapa das pastas

| Pasta | O que tem |
|---|---|
| `index.ts` (raiz) | Só reexporta o app de `src/index.ts`; é a entrada do bundle esbuild (`_bundle.cjs`) |
| `src/index.ts` | Monta o Express: CORS, handler do Better Auth em `/api/auth/*`, rotas sob `/api` e, fora da Vercel, o servidor e o worker local |
| `src/routes/` | Rotas por superfície: `public/`, `protected/` e `internal/` |
| `src/middlewares/` | `requireAuth` (sessão do Better Auth) |
| `src/controllers/` | Um controller por fluxo, nas mesmas três superfícies das rotas |
| `src/services/` | Regras de negócio dos fluxos de IA, de configuração de IA e de métricas |
| `src/repositories/` | Queries Drizzle; as de dados da empresa exigem o `enterprise_id` (`tenantScope.ts`) |
| `src/providers/` | Chamadas HTTP ao `ia-analyze` |
| `src/libs/` | Lógica de domínio: estatística, métricas, lotes da IA, worker (`iaJob/`), chave de IA (`iaConfig/`), avaliação do classificador (`eval/`) |
| `src/auth/` | Instância do Better Auth, e-mails, mapa de erros e os ganchos de criação (`enterpriseOnSignup.ts`) e exclusão (`enterpriseOnDelete.ts`) da empresa |
| `src/db/` | Cliente Drizzle e os filtros de tenant (`tenantScope.ts`) |
| `src/config/` | Códigos de erro e as perguntas padrão da empresa |
| `src/utils/` | Cifra da chave (`crypto.ts`), `sendTypedError` e a checagem do token do worker |
| `src/types/` | Tipos locais e a extensão do `Request` do Express |
| `drizzle/` | Schema (`schema.ts` + `schema/`) e as migrations SQL, a fonte única do banco ([ADR-0001](adr/0001-fonte-unica-de-schema.md)) |

### Suporte a Serviços Serverless Independentes

Ao invés de processar tudo no mesmo lugar e sobrecarregar o API Gateway, nossa arquitetura oferece suporte à extração de processamentos pesados ou integrações específicas para **serviços Serverless independentes**.

**Por que separar?**
- **Escalabilidade independente:** Serviços com alta demanda de processamento podem escalar sem exigir mais recursos do Gateway.
- **Isolamento de falhas:** Se um serviço ou integração externa falhar, o sistema principal continua operando normalmente.
- **Responsividade:** Permite que o Gateway continue rápido e responsivo para as requisições do Frontend, mesmo lidando com tarefas demoradas.

Um exemplo prático dessa aplicação no nosso sistema é o serviço Serverless `ia-analyze`, que lida com a inteligência artificial. Ele isola as chamadas à API do provedor LLM externo, reduzindo o risco de gargalos no Gateway durante análises massivas de texto.

## Processamento Assíncrono: Fila + Worker (etapa 03)

Todo trabalho de IA roda **fora da requisição HTTP do usuário**, num padrão **produtor–consumidor**. O worker ainda respeita os limites de tempo e de cota do provedor:

- **Produtor:** os pedidos de IA sempre **enfileiram** um job na tabela `ia_analysis_job` (que é a fila **e** o status), sem esperar a IA. São quatro tipos: `analyze_raw` e `regenerate_insights` (respondem `202 + jobId`), `generate_scope_diagnosis` (diagnóstico do escopo) e `generate_company_questions` (as perguntas da empresa, geradas sozinhas quando o contexto e a IA ficam configurados).
- **Consumidor (worker):** o `drainJobs()` (`src/libs/iaJob/`) puxa jobs com `SELECT ... FOR UPDATE SKIP LOCKED` e lease, processa **lote a lote** e, no relatório, executa um **reduce final**, retomando de onde parou entre execuções. Não exige um host sempre-ligado; a fila anda por quatro caminhos:
  - logo depois do pedido, com `kickWorker()` (na Vercel, `waitUntil` mantém a função viva até o passo terminar);
  - ao carregar páginas e no polling de status, com `kickWorkerIfPending()`, se a empresa tiver job pronto;
  - pelo cron de reserva do GitHub Actions ([`ia-worker.yml`](../.github/workflows/ia-worker.yml), a cada 5 minutos), que chama o endpoint interno `POST /api/internal/worker/tick` com o token `WORKER_TICK_TOKEN`;
  - fora da Vercel, por um loop local (`workerLoop.ts`) que sobe junto com o servidor.
- **Rate limiter:** um *token bucket* durável (`ia_rate_budget`, por minuto/dia **e por empresa**) dita o ritmo das chamadas ao LLM (back-pressure) em vez de estourar a cota; jobs sem orçamento aguardam a próxima janela.
- **Idempotência/resiliência:** dedup do pedido (índice parcial único em `ia_analysis_job`), `unique(feedback_id)` em `feedback_analysis` e retomada por lote.

O frontend acompanha o progresso por **polling** (`GET /api/protected/ia-analyze/jobs/:id`) e recupera trabalhos ativos em `GET /api/protected/ia-analyze/jobs`. Não existe seleção de modo síncrono. Consulte [operação do worker](etapa-03-operacao-worker.md).

## Provedor de LLM Configurável / BYO-key (etapa 04)

O motor de análise depende de uma **porta** (`IaApiClient`), não de um provedor concreto — padrão **Strategy/Adapter** (implementado no `ia-analyze`): dá para usar **Gemini** ou **OpenRouter** por configuração. Além disso, cada empresa pode trazer a **própria chave** (BYO-key), o que isola cota e custo por tenant:

- A chave/modelo por empresa ficam em `enterprise_ia_config`, **cifrados** (AES-256-GCM — `src/utils/crypto.ts`). Os endpoints `/user/ia-config` e `/user/ia-models` (`controllers/protected/iaConfig.controller.ts` → `services/iaConfig.service.ts` → `repositories/iaConfig.repository.ts`) salvam a chave colada ou a obtida pelo "Conectar com OpenRouter" (OAuth PKCE, `src/libs/iaConfig/openRouterAuth.ts`), trocam o modelo, listam os modelos e removem a config. **Nunca** retornam a chave (só `hasKey`/provedor/modelo/`keyHint`).
- Na análise, o Gateway resolve e decifra a config OpenRouter da empresa (`src/libs/iaConfig/`) e a envia ao `ia-analyze` por **header** (`x-llm-*`) — fora do corpo e dos logs. Sem config, responde `ia_config_required` por padrão; o fallback global legado só é reativado explicitamente com `REQUIRE_USER_IA_KEY=false`.
