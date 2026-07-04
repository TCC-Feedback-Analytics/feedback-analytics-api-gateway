-- auth.users — versão MÍNIMA para o ambiente LOCAL (não é o GoTrue do Supabase).
--
-- Em produção, `auth.users` é gerenciada pelo Supabase (dezenas de colunas,
-- coluna gerada `confirmed_at`, triggers de signup). Aqui só recriamos o mínimo
-- para satisfazer o FK `enterprise.auth_user_id`, a view `enterprise_public`
-- (lê `raw_user_meta_data->>'full_name'`) e o seed.
--
-- Os triggers de signup (on_auth_user_created → cria empresa/trial/perguntas)
-- NÃO são recriados aqui: o seed insere empresas diretamente, de forma
-- determinística. Na Fase 1 da migração, o Better Auth substitui esta tabela
-- por `user`/`session`/`account` próprias.

CREATE SCHEMA IF NOT EXISTS "auth";

CREATE TABLE IF NOT EXISTS "auth"."users" (
  "id" uuid PRIMARY KEY,
  "email" varchar(255),
  "phone" text,
  "raw_user_meta_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "email_confirmed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "users_phone_unique" UNIQUE ("phone")
);
