# Banco com o mínimo de privilégio

> **Em uma frase:** o gateway deixa de entrar no banco como `postgres` (dono de tudo) e passa a usar o papel `feedback_app`, que só lê e escreve dados. Se a senha do app vazar, ninguém consegue apagar tabelas, desligar a RLS nem criar usuários.

Item da etapa 07 (Segurança e LGPD). Vem da lacuna nº 1 do [mapa de ameaças](https://github.com/TCC-Feedback-Analytics/feedback-analytics/blob/main/docs/seguranca/mapa-de-ameacas.md).

## O que a migration `0013` faz

[`drizzle/0013_banco_menor_privilegio.sql`](../drizzle/0013_banco_menor_privilegio.sql):

1. **Liga a RLS nas nove tabelas que estavam sem ela:** `user`, `session`, `account`, `verification`, `user_onboarding`, `enterprise_ia_config`, `ia_analysis_job`, `ia_rate_budget` e `scope_diagnosis`. Agora as 24 tabelas criadas pelas migrations `0000` a `0013` têm RLS.
2. **Cria o papel `feedback_app` sem login.** A senha **não fica no repositório**: o dono a define no Supabase (passo a passo abaixo).
3. **Dá ao `feedback_app` só leitura e escrita de dados** (`SELECT`, `INSERT`, `UPDATE`, `DELETE`), nas tabelas de hoje e nas que as próximas migrations criarem (`ALTER DEFAULT PRIVILEGES`).
4. **Cria a policy `feedback_app_all` em cada tabela.** Com a RLS ligada e sem policy, o banco barra todo papel que não é dono da tabela. A policy deixa passar só o `feedback_app`. O isolamento entre empresas continua na aplicação (`src/db/tenantScope.ts`). Os outros papéis, como o `anon` e o `authenticated` do Supabase, seguem sem acesso.

As migrations continuam rodando como `postgres`, pelo secret `DATABASE_URL` do GitHub (`.github/workflows/deploy-api.yml`). Só o app, na Vercel, troca de usuário.

## Conferido no banco local (02/11/2026)

Com o gateway local rodando como `feedback_app`:

| Teste | Resultado |
|---|---|
| Ler as 25 tabelas | ✅ |
| Cadastro, login, ativar o QR, feedback público, métricas, lista, linha do tempo, pico, clientes que voltam, perguntas, configuração de IA e excluir a conta | ✅ todos com resposta 200, e nada sobrou no banco depois de excluir |
| Criar, alterar, apagar ou esvaziar (`TRUNCATE`) uma tabela | ✅ recusado (`42501`) |
| Desligar a RLS ou criar outro papel | ✅ recusado (`42501`) |
| Um papel sem a policy lê os feedbacks | ✅ vê 0 linhas |

## Passo a passo da troca (dono)

> **Situação em 03/11/2026:** troca feita em produção. O app entra como `feedback_app`, e o Secret `DATABASE_URL` do GitHub, que aplica as migrations, segue com o `postgres`. Os passos abaixo ficam como registro e para refazer a troca em outro banco.

A migration só chega ao Supabase pelo workflow **Deploy Api Gateway (Vercel)**, que roda manualmente e só na `main`. Merge na `developer` não muda o banco: o papel `feedback_app` só existe depois do deploy de produção.

1. **Release e deploy.** Faça o merge da release na `main` e rode o workflow **Deploy Api Gateway (Vercel)** com `ok`. Ele aplica a migration `0013` com o usuário `postgres`. Nada muda para o app ainda: ele continua entrando como `postgres`. Para conferir, rode `SELECT rolname FROM pg_roles WHERE rolname = 'feedback_app';` no SQL Editor; deve voltar uma linha.
2. **Dar a senha ao `feedback_app`.** Gere uma senha só com letras e números, para não precisar escapar na URL:

    ```bash
    openssl rand -hex 24
    ```

    No Supabase, em **SQL Editor**, rode (com a senha gerada):

    ```sql
    ALTER ROLE feedback_app WITH LOGIN PASSWORD 'cole-a-senha-aqui';
    ```

3. **Montar a nova `DATABASE_URL`.** É a mesma URL de hoje, trocando o usuário e a senha. No pooler do Supabase, o usuário leva o id do projeto:

    ```text
    postgresql://feedback_app.<ref>:<senha>@<host>:<porta>/postgres
    ```

4. **Trocar na Vercel.** No projeto do gateway, em **Settings › Environment Variables**, troque a `DATABASE_URL` do ambiente certo e faça um **Redeploy**.
5. **Testar.** Entre no painel, abra o Dashboard, mande um feedback pelo formulário público e confira se ele chega.
6. **Não mexa no secret `DATABASE_URL` do GitHub.** Ele continua com o `postgres`, porque as migrations precisam criar e alterar tabelas.

**Para voltar atrás:** recoloque a `DATABASE_URL` antiga na Vercel e faça um novo deploy. A migration pode ficar: o `postgres` é o dono das tabelas, e a RLS não vale para o dono.

## Tabela nova daqui para frente

Toda migration que cria uma tabela precisa, na mesma migration:

```sql
ALTER TABLE public.nova_tabela ENABLE ROW LEVEL SECURITY;
CREATE POLICY feedback_app_all ON public.nova_tabela FOR ALL TO feedback_app USING (true) WITH CHECK (true);
```

As permissões de leitura e escrita já vêm sozinhas, pelo `ALTER DEFAULT PRIVILEGES`. Sem a policy, o app recebe zero linhas da tabela nova, e o erro aparece logo no primeiro teste.

## No banco local

O banco do Docker continua usando o `postgres`. Para testar como o app de produção:

```sql
ALTER ROLE feedback_app WITH LOGIN PASSWORD 'feedback_app_local';
```

```text
DATABASE_URL=postgresql://feedback_app:feedback_app_local@127.0.0.1:5433/feedback
```
