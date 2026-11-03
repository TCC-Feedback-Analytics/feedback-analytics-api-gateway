# feedback-analytics-api-gateway

**Backend-for-Frontend (BFF)** do [Feedback Analytics](https://github.com/TCC-Feedback-Analytics/feedback-analytics) — o **único ponto de entrada** do backend. O frontend nunca acessa o banco ou o serviço de IA diretamente: tudo passa por aqui (autenticação, sessão, regras de negócio, estatísticas e orquestração da IA).

- **Runtime:** Node.js 20+ · TypeScript (ESM) · Express 5
- **Auth:** **Better Auth** (único provedor) — e-mail e senha ou **Google** · sessão em **cookie httpOnly** (sem `Authorization: Bearer`), sobre o Postgres via Drizzle
- **Dados:** **Drizzle ORM** (via `DATABASE_URL`) como único caminho de acesso — o app entra com o papel `feedback_app`, que só lê e escreve dados ([banco com o mínimo de privilégio](docs/banco-menor-privilegio.md)); a policy da RLS deixa esse papel ver todas as linhas, então o isolamento por `enterprise_id` é forçado na aplicação (`src/db/tenantScope.ts`)
- **Contratos:** tipos e schemas Zod de [`@feedback/lib-shared`](https://github.com/TCC-Feedback-Analytics/feedback-analytics-contracts) (git tag `v1.8.0`)
- **Deploy:** Vercel serverless (bundle esbuild `index.ts → _bundle.cjs`, `maxDuration` 300s)

## Rodar localmente

Este repositório **é** o serviço — os comandos rodam na raiz dele.

**Pré-requisito:** Docker Desktop no ar — o banco local (Postgres + Mailpit) sobe via Docker.

```bash
npm install
cp .env.example .env    # p/ dev local, use DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/feedback

npm run db:local:up     # sobe Postgres (:5433) + Mailpit (:8025) via Docker
npm run db:reset        # cria o schema + seed determinístico (exige DATABASE_URL local)
npm run dev             # http://localhost:3000

npm run db:local:down   # ao terminar: derruba os containers (os dados ficam no volume)
```

```bash
npm test                # testes (Vitest)
npm run lint
```

> Em dev, os e-mails de confirmação/recuperação caem no **Mailpit** (http://localhost:8025) — não são enviados de verdade. Detalhes do banco local em [`db/local/README.md`](db/local/README.md).

Variáveis de ambiente: a lista comentada, com o ambiente em que cada uma vale (Local, Preview, Produção), está no [`.env.example`](.env.example).

Migrations do banco (Drizzle): ver [`docs/migrations-drizzle.md`](docs/migrations-drizzle.md).

## Superfície HTTP

Todas as rotas são montadas sob **`/api`** (`app.use('/api', ...)` em `index.ts`), com sub-superfícies **pública** (`/api/public/...`), **protegida** (`/api/protected/...`, sessão via cookie) e **interna** (`/api/internal/...`, token — ex.: o tick do worker assíncrono). Além delas, o handler nativo do Better Auth responde em **`/api/auth/*`** (montado antes do `express.json()`), que inclui a entrada com o Google e a exclusão de conta (`POST /api/auth/delete-user`). Referência completa em [`docs/endpoints.md`](docs/endpoints.md).

## Arquitetura BFF em camadas

1. **Endpoints HTTP (`routes/`)** — expõem rotas públicas e protegidas para o frontend.
2. **Middlewares e segurança** — o CORS (allowlist manual) fica em `src/index.ts`; a autenticação fica em `middlewares/`: `requireAuth` valida a sessão do cookie via Better Auth (`getAuth().api.getSession()`) e injeta `req.user`/`req.enterpriseId` nas rotas protegidas (os endpoints públicos não passam por `requireAuth`). A configuração do Better Auth vive em `auth/`: e-mail e senha, Google, envio dos e-mails, criação da empresa no cadastro e exclusão da empresa antes de apagar a conta (`enterpriseOnDelete.ts`).
3. **Orquestração / regras de negócio (`controllers/`)** — coordenam o caso de uso; nos fluxos mais complexos delegam para:
   - **Services (`services/`)** — regras de negócio e orquestração. Exemplos:
     - a **análise de IA** (`iaAnalyze.service.ts`): monta lotes por escopo, aplica regras e persiste;
     - as **métricas do escopo** (`scopeMetrics.service.ts` e `questionMetrics.service.ts`): calculam estrelas, comentários, perguntas, movimento, pico e clientes no período. As telas e o diagnóstico do escopo usam os mesmos números;
     - o **diagnóstico do escopo** (`scopeDiagnosis.service.ts`) e a **geração automática das perguntas da empresa** (`companyQuestionsAutoGenerate.service.ts`), que enfileiram o pedido para o worker.
   - **Providers (`providers/`)** — adaptadores de rede para o serviço `ia-analyze`: `iaAnalyze.provider.ts` (análise e relatório), `scopeDiagnosis.provider.ts` e `companyQuestionSuggestions.provider.ts`.
   - **Repositories (`repositories/`)** — acesso a dados via **Drizzle** (`DATABASE_URL`), com isolamento por `enterprise_id` forçado na aplicação (a RLS deixa o papel do app ver todas as linhas). Detalhes em [Arquitetura e estrutura](docs/arquitetura-estrutura.md).
4. **Contratos e respostas tipadas** — payloads e erros padronizados (`sendTypedError`), com schemas Zod de `@feedback/lib-shared`.

Todo trabalho de IA roda **assíncrono**: análise, relatório, diagnóstico do escopo e geração das perguntas entram na fila `ia_analysis_job` e o worker `drainJobs` processa. A fila anda logo depois do pedido (`kickWorker`, com `waitUntil` na Vercel), a cada consulta de status e, como reserva, pelo cron do GitHub Actions ([`ia-worker.yml`](.github/workflows/ia-worker.yml), a cada 5 minutos, via `POST /api/internal/worker/tick`); fora da Vercel, um loop local também drena. Cada empresa usa a **própria chave de LLM** (BYO-key OpenRouter, cifrada em `enterprise_ia_config`). Ver [Arquitetura e estrutura](docs/arquitetura-estrutura.md).

## Documentação

- [Visão geral](docs/visao-geral.md) · [Arquitetura e estrutura](docs/arquitetura-estrutura.md) · [Endpoints](docs/endpoints.md) · [Migrations (Drizzle)](docs/migrations-drizzle.md) · [Todos os documentos](docs/README.md)
- CI/CD e deploy: [`.github/CI_SETUP.md`](.github/CI_SETUP.md)
- Decisão **ORM × RLS**, concepção, decisões e produto: [repositório central de documentação](https://github.com/TCC-Feedback-Analytics/feedback-analytics)
