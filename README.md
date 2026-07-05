# feedback-analytics-api-gateway

**Backend-for-Frontend (BFF)** do [Feedback Analytics](https://github.com/TCC-Feedback-Analytics/feedback-analytics) — o **único ponto de entrada** do backend. O frontend nunca acessa o banco ou o serviço de IA diretamente: tudo passa por aqui (autenticação, sessão, regras de negócio, estatísticas e orquestração da IA).

- **Runtime:** Node.js 20+ · TypeScript (ESM) · Express 5
- **Auth:** **Better Auth** (único provedor) — o gateway expõe os endpoints de autenticação e mantém a sessão em **cookie httpOnly** (sem `Authorization: Bearer`); as tabelas do Better Auth (`user`/`session`/`account`/`verification`) ficam no Postgres
- **Dados:** **Drizzle ORM** (via `DATABASE_URL`) — todo acesso a dados passa pelo Drizzle; o banco é o **Postgres do Supabase** (acessado direto por connection string, sem o SDK do Supabase). O isolamento por empresa (tenant) é feito na aplicação, já que o role do Drizzle ignora a RLS
- **E-mail:** confirmação de cadastro e recuperação de senha enviados pelo gateway via **SMTP** (SendGrid em produção, Mailpit no local)
- **Contratos:** tipos e schemas Zod de [`@feedback/lib-shared`](https://github.com/TCC-Feedback-Analytics/feedback-analytics-contracts) (git tag `v1.0.0`)
- **Deploy:** Vercel serverless (bundle esbuild `index.ts → _bundle.cjs`, `maxDuration` 300s)

## Rodar localmente

Este repositório **é** o serviço — os comandos rodam na raiz dele:

```bash
npm install
cp .env.example .env    # preencha DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL, SMTP_*, IA_ANALYZE_*
npm run dev             # http://localhost:3000
```

> `BETTER_AUTH_SECRET` é obrigatório — sem ele o app **não sobe** (gere com `openssl rand -base64 32`). E-mail no local usa Mailpit (`SMTP_HOST=127.0.0.1`, `SMTP_PORT=1025`).

```bash
npm test                # testes (Vitest)
npm run lint
```

Migrations do banco (Drizzle): ver [`docs/migrations-drizzle.md`](docs/migrations-drizzle.md).

## Superfície HTTP

Todas as rotas são montadas sob **`/api`** (`app.use('/api', ...)` em `index.ts`), com sub-superfícies **pública** (`/api/public/...`) e **protegida** (`/api/protected/...`, exige sessão via cookie). Referência completa em [`docs/endpoints.md`](docs/endpoints.md).

## Arquitetura BFF em camadas

1. **Endpoints HTTP (`routes/`)** — expõem rotas públicas e protegidas para o frontend.
2. **Middlewares e segurança (`middlewares/`)** — CORS (allowlist manual) e autenticação: `requireAuth` valida a sessão do cookie via **Better Auth** e injeta `req.user` nas rotas protegidas (os endpoints públicos não passam por `requireAuth`).
3. **Orquestração / regras de negócio (`controllers/`)** — coordenam o caso de uso; nos fluxos mais complexos delegam para:
   - **Services (`services/`)** — regras de negócio e orquestração. Hoje o único Service é a **análise de IA** (`iaAnalyze.service.ts`): monta lotes por escopo, aplica regras e persiste.
   - **Providers (`providers/`)** — adaptadores de rede para serviços externos (ex.: `iaAnalyze.provider.ts`, o ponto que faz a chamada HTTP ao serviço `ia-analyze`).
   - **Repositories (`repositories/`)** — acesso a dados via **Drizzle** (`DATABASE_URL`), com isolamento por `enterprise_id` forçado na aplicação (o role do Drizzle ignora a RLS). Detalhes em [Arquitetura e estrutura](docs/arquitetura-estrutura.md).
4. **Contratos e respostas tipadas** — payloads e erros padronizados (`sendTypedError`), com schemas Zod de `@feedback/lib-shared`.

## Documentação

- [Visão geral](docs/visao-geral.md) · [Arquitetura e estrutura](docs/arquitetura-estrutura.md) · [Endpoints](docs/endpoints.md) · [Migrations (Drizzle)](docs/migrations-drizzle.md)
- CI/CD e deploy: [`.github/CI_SETUP.md`](.github/CI_SETUP.md)
- Decisão **ORM × RLS**, concepção, decisões e produto: [repositório central de documentação](https://github.com/TCC-Feedback-Analytics/feedback-analytics)
