-- ============================================================================
-- FASE 2 — Reconciliação da PRODUÇÃO ao schema single-source (ADR-0001 · Passo 8)
-- ============================================================================
-- Rode UMA vez no Postgres de produção (Supabase → SQL Editor), APÓS backup.
-- Traz o schema de prod para o estado do novo baseline (drizzle/0000 + 0001),
-- removendo os resíduos do Supabase Auth que o re-baseline eliminou localmente:
--   - a view enterprise_public com fallback em auth.users;
--   - as 4 funções legadas (clean_user_metadata_before_change,
--     create_enterprise_on_signup, jwt_custom_claims, phone_exists);
--   - a FK tracked_devices.blocked_by -> auth.users.
-- É IDEMPOTENTE (pode rodar de novo).
--
--   psql "$DATABASE_URL" -f db/cutover/fase2-prod-reconcile.sql
-- ============================================================================

BEGIN;

-- 1) View enterprise_public: passa a ler SÓ public.user (sem o fallback auth.users).
CREATE OR REPLACE VIEW public.enterprise_public AS
  SELECT e.id, pu.name AS name
  FROM public.enterprise e
  LEFT JOIN public."user" pu ON pu.id = e.auth_user_id;
GRANT SELECT ON public.enterprise_public TO anon, authenticated;

-- 2) Dropa as 4 funções legadas do Supabase Auth (e triggers que dependam delas),
--    independente da assinatura exata. Idempotente.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('clean_user_metadata_before_change', 'create_enterprise_on_signup',
                        'jwt_custom_claims', 'phone_exists')
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig || ' CASCADE';
  END LOOP;
END $$;

-- 3) Remove a FK tracked_devices.blocked_by -> auth.users (o baseline não a tem;
--    blocked_by permanece como uuid sem FK, igual ao local). Idempotente.
DO $$
DECLARE r RECORD;
BEGIN
  IF to_regclass('public.tracked_devices') IS NULL THEN RETURN; END IF;
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
    WHERE con.conrelid = 'public.tracked_devices'::regclass
      AND con.contype = 'f' AND a.attname = 'blocked_by'
  LOOP
    EXECUTE format('ALTER TABLE public.tracked_devices DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

COMMIT;

-- 4) (OPCIONAL — decisão) Depois de 1-3, nada em `public` referencia mais auth.users.
--    Confirme: SELECT que não sobrou view/função/FK apontando para auth.*:
--      SELECT n.nspname, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--       WHERE n.nspname='public' AND pg_get_functiondef(p.oid) ILIKE '%auth.%';
--      SELECT conrelid::regclass, conname FROM pg_constraint
--       WHERE contype='f' AND confrelid = 'auth.users'::regclass;
--    Estando limpo, dá para eliminar o schema `auth` fantasma do Supabase:
--      DROP SCHEMA IF EXISTS auth CASCADE;   -- IRREVERSÍVEL; só com backup fresco.
--    Manter `auth.users` como tabela morta também é seguro (nada a consome).
