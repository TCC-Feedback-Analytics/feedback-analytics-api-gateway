-- ============================================================================
-- CUTOVER (Fase 2, mão única) — finaliza a saída do Supabase Auth
-- ============================================================================
-- Rode UMA vez em produção (Supabase → SQL Editor) junto com o deploy que remove
-- 100% o código Supabase (o modo de rollback por AUTH_PROVIDER=supabase deixa de
-- existir a partir deste deploy). Idempotente.
--
--   psql "$DATABASE_URL" -f db/cutover/betterauth-finalize.sql
--
-- Pré-requisito: o db/cutover/betterauth-enable.sql (Fase 1) já foi aplicado.
-- ============================================================================

BEGIN;

-- Reescreve a view enterprise_public: o nome de exibição passa a vir de
-- public.user (Better Auth). O LEFT JOIN em auth.users é um fallback de
-- compatibilidade para empresas legadas do fluxo Supabase (se houver) — com o
-- INNER JOIN antigo, empresas Better Auth (sem linha em auth.users) SUMIRIAM da
-- view e o formulário público (QR) retornaria 404 para elas.
CREATE OR REPLACE VIEW "public"."enterprise_public" AS
SELECT
  e.id,
  COALESCE(pu.name, au.raw_user_meta_data ->> 'full_name') AS name
FROM "public"."enterprise" e
LEFT JOIN "public"."user" pu ON pu.id = e.auth_user_id
LEFT JOIN "auth"."users" au ON au.id = e.auth_user_id;

GRANT SELECT ON "public"."enterprise_public" TO anon, authenticated;

COMMIT;
