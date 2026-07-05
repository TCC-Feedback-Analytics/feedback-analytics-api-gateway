-- ============================================================================
-- CUTOVER (Fase 1, REVERSÍVEL) — habilita o Better Auth em PRODUÇÃO
-- ============================================================================
-- Rodar UMA vez no Postgres de produção ANTES de fazer deploy do código com o
-- default AUTH_PROVIDER=betterauth:
--
--   psql "$DATABASE_URL" -f db/cutover/betterauth-enable.sql
--
-- É IDEMPOTENTE (pode rodar de novo sem efeito colateral) e NÃO quebra o modo
-- supabase — o rollback continua sendo só setar AUTH_PROVIDER=supabase (sem
-- redeploy). A migração de dados (Fase 2) já rodou: TODO acesso a dados é via
-- Drizzle, que ignora a RLS; por isso dropar as policies aqui é seguro.
--
-- NÃO faz as mudanças de MÃO ÚNICA (reescrever a view enterprise_public →
-- public.user e remover o código/deps Supabase) — essas ficam no PR2, após
-- validar o Better Auth em produção.
-- ============================================================================

BEGIN;

-- 1) Tabelas core do Better Auth (espelham src/auth/schema.ts). Idempotente.
CREATE TABLE IF NOT EXISTS "public"."user" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"           text,
  "email"          text NOT NULL UNIQUE,
  "email_verified" boolean NOT NULL DEFAULT false,
  "image"          text,
  "phone"          text UNIQUE,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "public"."session" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"    uuid NOT NULL REFERENCES "public"."user"("id") ON DELETE CASCADE,
  "token"      text NOT NULL UNIQUE,
  "expires_at" timestamptz NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "public"."account" (
  "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"                  uuid NOT NULL REFERENCES "public"."user"("id") ON DELETE CASCADE,
  "account_id"               text NOT NULL,
  "provider_id"              text NOT NULL,
  "access_token"             text,
  "refresh_token"            text,
  "access_token_expires_at"  timestamptz,
  "refresh_token_expires_at" timestamptz,
  "scope"                    text,
  "id_token"                 text,
  "password"                 text,
  "created_at"               timestamptz NOT NULL DEFAULT now(),
  "updated_at"               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "public"."verification" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "identifier" text NOT NULL,
  "value"      text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- 2) Remove a FK enterprise.auth_user_id → auth.users. Os usuários do Better
-- Auth vivem em public.user (NÃO em auth.users); sem remover esta FK, o signup
-- betterauth (provisionEnterpriseForUser) viola a constraint. O schema LOCAL já
-- não tem essa FK — isto alinha a produção. (Não recriamos apontando p/ public.user
-- ainda: isso é mão única e fica no PR2.)
DO $$
DECLARE
  r RECORD;
  enterprise_oid oid := to_regclass('public.enterprise');
  auth_users_oid oid := to_regclass('auth.users');
BEGIN
  -- to_regclass devolve NULL (sem erro) se o objeto não existir → script robusto
  -- mesmo num banco sem o schema `auth` (ex.: pós-PR2). Sem alvo, nada a fazer.
  IF enterprise_oid IS NULL OR auth_users_oid IS NULL THEN
    RETURN;
  END IF;
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = enterprise_oid
      AND contype = 'f'
      AND confrelid = auth_users_oid
  LOOP
    EXECUTE format('ALTER TABLE public.enterprise DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

-- 3) Dropa as policies RLS (auth.uid()/anon) das tabelas de dados. São
-- REDUNDANTES: o acesso a dados é 100% via Drizzle (role que ignora a RLS). A
-- RLS continua HABILITADA (sem policies = deny para anon/authenticated, que não
-- são mais usados) — postura mais restritiva, não menos. Remover as policies
-- também elimina a dependência de auth.uid() antes de o PR2 remover o Supabase.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'enterprise', 'collecting_data_enterprise', 'catalog_items',
        'collection_points', 'customer', 'tracked_devices',
        'questions_of_feedbacks', 'feedback_question_subquestions',
        'feedback', 'feedback_question_answers', 'feedback_subquestion_answers',
        'feedback_analysis', 'feedback_insights_report'
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, r.tablename);
  END LOOP;
END $$;

COMMIT;
