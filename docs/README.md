# Documentação — API Gateway

- [Visão geral](visao-geral.md) — o que o gateway é, por que existe, o que faz e as funcionalidades.
- [Arquitetura e estrutura](arquitetura-estrutura.md) — o BFF no sistema, as camadas, o mapa de `src/`, a fila de IA e a chave de LLM por empresa.
- [Endpoints](endpoints.md) — referência das rotas da API.
- [Migrations (Drizzle)](migrations-drizzle.md) — a convenção do schema único e como criar e aplicar migrations.
- [Banco com o mínimo de privilégio](banco-menor-privilegio.md) — o papel `feedback_app`, a migration `0013` e o passo a passo da troca.
- [Operação do worker assíncrono (etapa 03)](etapa-03-operacao-worker.md) — como a fila de IA roda no local e na Vercel, e as variáveis do worker.
- [Handoff da etapa 04 para o frontend](etapa-04-frontend-handoff.md) — contrato e UX da tela de chave OpenRouter por empresa (BYO-key).
- [Guia do sistema: integração do frontend](onboarding-api.md) — como a Web consulta e conclui o guia do sistema (`/user/onboarding/system-guide`).
- Decisões de arquitetura (ADR):
  - [ADR-0001: fonte única de schema](adr/0001-fonte-unica-de-schema.md) — por que o schema vive só em `drizzle/schema.ts` + migrations.
  - [Plano da Fase 2 do ADR-0001](adr/0001-plano-fase2-rebaseline.md) — o runbook do re-baseline para a fonte única.

Como rodar: [README do repositório](../README.md). Variáveis de ambiente: [`.env.example`](../.env.example). Banco local (Docker): [`db/local/README.md`](../db/local/README.md). CI/CD e deploy: [`.github/CI_SETUP.md`](../.github/CI_SETUP.md).

Concepção, decisões e produto vivem no [repositório central de documentação](https://github.com/TCC-Feedback-Analytics/feedback-analytics).
