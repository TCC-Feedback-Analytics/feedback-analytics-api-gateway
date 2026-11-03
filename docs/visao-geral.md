# Backend — Visão Geral (API Gateway)

## O Que É

O `api-gateway` é o **Backend-for-Frontend (BFF)** do sistema. Ele é o único ponto de entrada do backend — o frontend nunca acessa o banco de dados ou o serviço de IA diretamente.

## Por Que Existe

Centralizar o backend permite:
- **Autenticação uniforme** — um único middleware valida a sessão do Better Auth (cookie HttpOnly) para todos os endpoints **protegidos** (os públicos não passam por `requireAuth`)
- **Isolamento do banco** — as queries ficam no backend; o frontend não precisa de acesso direto ao banco
- **Orquestração da IA** — o Gateway prepara os dados, chama o `ia-analyze` e persiste os resultados. Todo trabalho de IA roda **de forma assíncrona** (fila + worker, etapa 03) e cada empresa usa a **própria chave de LLM** (BYO-key OpenRouter, etapa 04) — sem expor a complexidade ao cliente

## Responsabilidades

1. **Autenticar** — cadastro com e-mail e senha ou entrada com o Google, sessão em cookie httpOnly validada via Better Auth (`getAuth().api.getSession()`, no middleware `requireAuth`) e exclusão da conta com tudo da empresa
2. **Expor endpoints REST** para o frontend React
3. **Ler e escrever** no banco de dados (Postgres, via Drizzle)
4. **Calcular as métricas do escopo** — os números das telas e do diagnóstico saem do mesmo cálculo
5. **Orquestrar serviços** — enfileira pedidos; o worker busca feedbacks, monta batches, chama `ia-analyze` e persiste resultados

## Funcionalidades

- **Conta:** cadastro com senha (cria a empresa e as 3 perguntas padrão), entrada com o Google (a empresa nasce na primeira entrada e a pessoa completa o cadastro com nome, telefone e aceite dos termos), confirmação de e-mail, recuperação de senha e **exclusão da conta** (`src/auth/enterpriseOnDelete.ts` apaga a empresa e tudo dela antes de o Better Auth apagar o usuário).
- **Empresa e coleta:** dados da empresa, perguntas do feedback geral e dos itens do catálogo (produto, serviço, departamento), ativação do QR Code da empresa e de cada item, e o **campo de comentário por escopo** (padrão, texto próprio ou oculto).
- **Formulário público:** dados da empresa e perguntas do escopo, envio do feedback com o **canal de coleta** (QR Code, link ou NFC; o "Testar o formulário" fica fora das métricas).
- **Métricas do escopo:** estatísticas, perguntas, movimento no tempo, dias e horários de pico, clientes que voltam, avaliações por canal e participação nos comentários.
- **IA:** análise dos feedbacks pendentes, relatório de insights, **diagnóstico do escopo** e **geração automática das perguntas da empresa** quando o contexto e a IA estão configurados — tudo pela fila.
- **Configuração de IA:** chave OpenRouter da empresa (colada ou por "Conectar com OpenRouter"), cifrada no banco, e escolha do modelo.
- **Guia do sistema:** estado do tour da Web por usuário ([integração](onboarding-api.md)).

## Superfícies da API

Todas as rotas ficam sob `/api`. A referência completa, rota a rota, está em [Endpoints](./endpoints.md).

| Superfície | Prefixo | Acesso |
|---|---|---|
| Pública | `/api/public/...` e `/api/health` | Sem autenticação |
| Protegida | `/api/protected/...` | Sessão do Better Auth (cookie HttpOnly), via `requireAuth` |
| Interna | `/api/internal/worker/tick` | Token `WORKER_TICK_TOKEN` (header `x-worker-token`), chamado pelo cron de reserva do GitHub Actions |
| Better Auth | `/api/auth/*` | Handler nativo do Better Auth (Google, exclusão de conta e demais rotas dele) |

## Tecnologias

- **Runtime:** Node.js 20+ com TypeScript (ESM)
- **Framework:** Express 5
- **Auth:** **Better Auth** (único provedor), com e-mail e senha e Google — sessão em cookie httpOnly, validada por `getAuth().api.getSession()` em `requireAuth`; não há `Authorization: Bearer`
- **Dados:** **Drizzle ORM** (`DATABASE_URL`) como único caminho — o app entra com o papel `feedback_app`, que só lê e escreve dados ([banco com o mínimo de privilégio](./banco-menor-privilegio.md)); a RLS deixa esse papel ver todas as linhas, então o isolamento por `enterprise_id` fica na aplicação. O Supabase permanece apenas como **provedor do Postgres**
- **E-mail:** nodemailer via SMTP (Mailpit no local, Brevo em produção)
- **Contratos:** `@feedback/lib-shared` (tag `v1.8.0`)
- **Deploy:** Vercel (serverless)

## Veja Também

- [Arquitetura e Estrutura](./arquitetura-estrutura.md)
- [Referência de Endpoints](./endpoints.md)
- [Todos os documentos](./README.md)
- [Regras de Negócio](https://github.com/TCC-Feedback-Analytics/feedback-analytics/blob/main/docs/produto/regras-negocio.md)
