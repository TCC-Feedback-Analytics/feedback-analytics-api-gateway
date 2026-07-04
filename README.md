# feedback-analytics-api-gateway

**Backend-for-Frontend (BFF)** do [Feedback Analytics](https://github.com/TCC-Feedback-Analytics/feedback-analytics) — o **único ponto de entrada** do backend. O frontend nunca acessa o banco ou o serviço de IA diretamente: tudo passa por aqui (autenticação, sessão, regras de negócio, estatísticas e orquestração da IA).

- **Runtime:** Node.js 20+ · TypeScript (ESM) · Express 5
- **Auth:** Supabase Auth via `@supabase/ssr` — sessão em **cookie httpOnly** (sem `Authorization: Bearer`)
- **Dados:** dois caminhos — cliente **Supabase** (`@supabase/ssr`, sujeito à RLS) e **Drizzle ORM** (via `DATABASE_URL`, para as agregações de estatística, com isolamento por `enterprise_id` forçado na aplicação)
- **Contratos:** tipos e schemas Zod de [`@feedback/lib-shared`](https://github.com/TCC-Feedback-Analytics/feedback-analytics-contracts) (git tag `v1.0.0`)
- **Deploy:** Vercel serverless (bundle esbuild `index.ts → _bundle.cjs`, `maxDuration` 300s)

## Rodar localmente

Este repositório **é** o serviço — os comandos rodam na raiz dele:

```bash
npm install
cp .env.example .env    # preencha SUPABASE_URL/ANON_KEY, DATABASE_URL, IA_ANALYZE_*
npm run dev             # http://localhost:3000
```

```bash
npm test                # testes (Vitest)
npm run lint
```

Migrations do banco (Drizzle): ver [`docs/migrations-drizzle.md`](docs/migrations-drizzle.md).

## Superfície HTTP

Todas as rotas são montadas sob **`/api`** (`app.use('/api', ...)` em `index.ts`), com sub-superfícies **pública** (`/api/public/...`) e **protegida** (`/api/protected/...`, exige sessão via cookie). Referência completa em [`docs/endpoints.md`](docs/endpoints.md).

## Arquitetura BFF em camadas

1. **Endpoints HTTP (`routes/`)** — expõem rotas públicas e protegidas para o frontend.
2. **Middlewares e segurança (`middlewares/`)** — CORS (allowlist manual) e autenticação: `requireAuth` valida a sessão do cookie via `supabase.auth.getUser()` e injeta `req.user`/`req.supabase` nas rotas protegidas (os endpoints públicos não passam por `requireAuth`).
3. **Orquestração / regras de negócio (`controllers/`)** — coordenam o caso de uso; nos fluxos mais complexos delegam para:
   - **Services (`services/`)** — regras de negócio e orquestração. Hoje o único Service é a **análise de IA** (`iaAnalyze.service.ts`): monta lotes por escopo, aplica regras e persiste.
   - **Providers (`providers/`)** — adaptadores de rede para serviços externos (ex.: `iaAnalyze.provider.ts`, o ponto que faz a chamada HTTP ao serviço `ia-analyze`).
   - **Repositories (`repositories/`)** — acesso a dados por **dois caminhos**: cliente **Supabase** (sujeito à RLS) e **Drizzle** (`DATABASE_URL`) para as agregações de estatística, com isolamento por `enterprise_id` na aplicação. Detalhes em [Arquitetura e estrutura](docs/arquitetura-estrutura.md).
4. **Contratos e respostas tipadas** — payloads e erros padronizados (`sendTypedError`), com schemas Zod de `@feedback/lib-shared`.

## Documentação

- [Visão geral](docs/visao-geral.md) · [Arquitetura e estrutura](docs/arquitetura-estrutura.md) · [Endpoints](docs/endpoints.md) · [Migrations (Drizzle)](docs/migrations-drizzle.md)
- CI/CD e deploy: [`.github/CI_SETUP.md`](.github/CI_SETUP.md)
- Decisão **ORM × RLS**, concepção, decisões e produto: [repositório central de documentação](https://github.com/TCC-Feedback-Analytics/feedback-analytics)
