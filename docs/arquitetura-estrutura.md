# Backend (API Gateway) — Arquitetura e Estrutura 

O backend utiliza uma combinação de padrões arquiteturais para garantir segurança, organização e escalabilidade.
Podemos dividir a arquitetura em duas visões:

- **Visão Macro:** Como o backend se encaixa no sistema inteiro
- **Visão Micro:** Como o código está organizado por dentro

## Visão Macro: API Gateway e BFF (Backend-For-Frontend)

O backend principal (o `api-gateway`) atua como um **Backend-for-Frontend (BFF)**. Isso significa que ele é o **único ponto de entrada** para o Frontend. O Frontend nunca acessa o banco de dados diretamente nem fala com serviços externos, tudo passa pelo *Gateway*.

Ele segue uma topologia **Hub-and-Spoke**, onde o API Gateway é o centro (hub) que orquestra a comunicação com:

- O banco de dados (Supabase / PostgreSQL).
- O serviço de autenticação (**Better Auth**, embutido no próprio gateway).
- Outros serviços Serverless.

**Vantagens disso:** Centraliza a validação de segurança (sessão via cookie httpOnly) e isola lógicas complexas, deixando o Frontend mais leve.

## Visão Micro: Arquitetura em Camadas (Layered Architecture)

Internamente, o API Gateway adota uma **Arquitetura em Camadas** como padrão de referência. O fluxo ideal segue um caminho de *ida e volta* entre as camadas:

1. **Rotas (`routes/`):** A porta de entrada. Recebem a requisição HTTP e direcionam para o controller correto.
2. **Middlewares (`middlewares/`):** A segurança. Validam a autenticação (o `requireAuth` valida a sessão via Better Auth) antes de deixar a requisição prosseguir, injetando `req.user` e `req.enterpriseId` na request.
3. **Controllers (`controllers/`):** Os "gerentes". Recebem a requisição validada, extraem os parâmetros ou o corpo (body) e resolvem a resposta.
4. **Services (`services/`):** O "cérebro". Concentram as regras de negócio mais complexas, validam requisitos (ex: verificar se há feedbacks suficientes para analisar) e orquestram o fluxo de dados.
5. **Repositories (`repositories/`):** Os "arquivistas". Encapsulam as queries ao banco de dados via **Drizzle** (`DATABASE_URL`), cujo role ignora a RLS — o isolamento por `enterprise_id` é forçado na aplicação (`src/db/tenantScope.ts`), com a RLS mantida no banco como defesa em profundidade. Ver [Migrations (Drizzle)](./migrations-drizzle.md).

> **Estado atual da implementação:** o padrão **completo** Controller → Service → Repository só existe na **análise de IA** (`iaAnalyze.service.ts` + `iaAnalyze.repository.ts`) — é o único fluxo com camada de Service. Vários fluxos usam **Controller → Repository** (sem Service): os **pontos de coleta/QR** (`collectionPointsQr.repository.ts`), o **feedback público** (`publicQuestions.repository.ts`) e as **estatísticas/análise** (`feedbackStats.repository.ts` — via Drizzle — + `scope.repository.ts`). Os fluxos de **empresa** ainda acessam tabelas diretamente no controller (Drizzle, sem repositório dedicado); já **usuário/autenticação/cadastro** usam o **Better Auth** (`getAuth().api.*`), sem acesso direto a tabelas. Migrar progressivamente esses fluxos para o padrão em camadas é um trabalho em aberto.

Há também pastas de apoio estrutural, como a `libs/`, que contém funções puras de domínio (sem efeitos colaterais) para ajudar em lógicas específicas (como montar lotes de análise para a IA), e os `providers/`, que fazem a comunicação HTTP com outros serviços

### Suporte a Serviços Serverless Independentes

Ao invés de processar tudo no mesmo lugar e sobrecarregar o API Gateway, nossa arquitetura oferece suporte à extração de processamentos pesados ou integrações específicas para **serviços Serverless independentes**.

**Por que separar?**
- **Escalabilidade independente:** Serviços com alta demanda de processamento podem escalar sem exigir mais recursos do Gateway.
- **Isolamento de falhas:** Se um serviço ou integração externa falhar, o sistema principal continua operando normalmente.
- **Responsividade:** Permite que o Gateway continue rápido e responsivo para as requisições do Frontend, mesmo lidando com tarefas demoradas.

Um exemplo prático dessa aplicação no nosso sistema é o serviço Serverless `ia-analyze`, que lida com a inteligência artificial. Ele isola as chamadas à API do provedor LLM externo, reduzindo o risco de gargalos no Gateway durante análises massivas de texto.
