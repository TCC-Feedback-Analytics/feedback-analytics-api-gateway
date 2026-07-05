# Backend — Visão Geral (API Gateway)

## O Que É

O `api-gateway` é o **Backend-for-Frontend (BFF)** do sistema. Ele é o único ponto de entrada do backend — o frontend nunca acessa o banco de dados ou o serviço de IA diretamente.

## Por Que Existe

Centralizar o backend permite:
- **Autenticação uniforme** — um único middleware valida a sessão do **Better Auth** (cookie HttpOnly) para todos os endpoints **protegidos** (os públicos não passam por `requireAuth`)
- **Isolamento do banco** — as queries ficam no backend; o frontend não acessa o banco diretamente
- **Orquestração da IA** — o Gateway prepara os dados, chama o `ia-analyze` e persiste os resultados sem expor a complexidade ao cliente

## Responsabilidades

1. **Validar autenticação** lendo a sessão do cookie httpOnly via **Better Auth** (middleware `requireAuth`)
2. **Expor endpoints REST** para o frontend React
3. **Ler e escrever** no banco de dados (Postgres do Supabase) via **Drizzle ORM**
4. **Orquestrar serviços** — busca feedbacks, monta batches, chama `ia-analyze`, persiste resultados
5. **Enviar e-mails** de confirmação de cadastro e recuperação de senha via **SMTP** (SendGrid em produção, Mailpit no local)

## Endpoints Disponíveis

### Protegidos (sessão via cookie HttpOnly)

| Método | Caminho | Descrição |
|---|---|---|
| `GET` | `/api/protected/user/auth_user` | Dados do usuário autenticado (da sessão) |
| `PATCH` | `/api/protected/user/email` | Atualiza e-mail (envia confirmação) |
| `PATCH` | `/api/protected/user/metadados` | Atualiza metadados do usuário (ex.: nome) |
| `POST` | `/api/protected/user/phone/start` | Inicia verificação de telefone (envia SMS) |
| `POST` | `/api/protected/user/phone/verify` | Confirma o código SMS do telefone |
| `PATCH` | `/api/protected/user/password` | Redefine a senha (usa sessão de recuperação) |
| `GET` | `/api/protected/user/enterprise` | Dados da empresa |
| `PATCH` | `/api/protected/user/enterprise` | Atualiza empresa |
| `GET` | `/api/protected/user/collecting_data` | Configurações de coleta |
| `PATCH` / `PUT` | `/api/protected/user/collecting_data` | Atualiza / upsert coleta |
| `GET` | `/api/protected/user/feedbacks` | Lista feedbacks |
| `GET` | `/api/protected/user/feedbacks/stats` | Estatísticas (inclui contagem de pendentes por escopo `pendingCount` e métricas de satisfação/sentimento) |
| `GET` | `/api/protected/user/feedbacks/questions` | Métricas determinísticas por pergunta/subpergunta no escopo |
| `GET` | `/api/protected/user/feedbacks/insights/report` | Relatório de insights |
| `GET` | `/api/protected/user/feedbacks/analysis` | Análises da IA |
| `GET` | `/api/protected/user/collection-points/qr/status` | Status do QR Code da empresa |
| `POST` | `/api/protected/user/collection-points/qr/enable` | Ativa o QR Code da empresa |
| `POST` | `/api/protected/user/collection-points/qr/disable` | Desativa o QR Code da empresa |
| `GET` | `/api/protected/user/collection-points/qr/catalog` | Lista itens de catálogo + status de QR (query `kind`) |
| `POST` | `/api/protected/user/collection-points/qr/catalog/questions/upsert` | Upsert das perguntas de um item de catálogo |
| `POST` | `/api/protected/user/collection-points/qr/catalog/enable` | Ativa o QR Code de um item de catálogo |
| `POST` | `/api/protected/user/collection-points/qr/catalog/disable` | Desativa o QR Code de um item de catálogo |
| `POST` | `/api/protected/ia-analyze/analyze-raw` | Analisa feedbacks brutos |
| `POST` | `/api/protected/ia-analyze/regenerate-insights` | Regenera insights |

### Públicos (sem autenticação)

| Método | Caminho | Descrição |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `POST` | `/api/public/auth/login` | Login (cria sessão via cookie) |
| `POST` | `/api/public/auth/logout` | Logout (invalida o cookie) |
| `POST` | `/api/public/auth/register` | Cadastro de nova conta |
| `POST` | `/api/public/auth/forgot-password` | Solicita e-mail de redefinição de senha |
| `POST` | `/api/public/auth/resend-confirmation` | Reenvia o e-mail de confirmação de cadastro |
| `GET` | `/api/public/auth/callback` | Callback de confirmação/recuperação (redireciona) |
| `ALL` | `/api/auth/*splat` | Rotas nativas do **Better Auth** (montadas via `toNodeHandler`) |
| `GET` | `/api/public/enterprise/:id` | Dados públicos da empresa + perguntas para o formulário |
| `POST` | `/api/public/qrcode/feedback` | Submissão de feedback via QR Code |

> Os endpoints `/api/public/auth/*` são wrappers do gateway (payloads e regras próprias) que chamam o **Better Auth** por baixo; o handler nativo do Better Auth fica montado em `/api/auth/*splat`.

## Tecnologias

- **Runtime:** Node.js 20+ com TypeScript (ESM)
- **Framework:** Express 5
- **Auth:** **Better Auth** (único provedor) — sessão em cookie httpOnly, validada em `requireAuth`; não há `Authorization: Bearer`. As tabelas do Better Auth (`user`/`session`/`account`/`verification`) ficam no Postgres
- **Dados:** **Drizzle ORM** (`DATABASE_URL`) sobre o **Postgres do Supabase** (acesso direto por connection string, sem SDK do Supabase), com isolamento por `enterprise_id` na aplicação (o role do Drizzle ignora a RLS)
- **E-mail:** SMTP (SendGrid em produção, Mailpit no local)
- **Deploy:** Vercel (serverless)

## Veja Também

- [Arquitetura e Estrutura](./arquitetura-estrutura.md)
- [Referência de Endpoints](./endpoints.md)
- [Regras de Negócio](https://github.com/TCC-Feedback-Analytics/feedback-analytics/blob/main/docs/produto/regras-negocio.md)
