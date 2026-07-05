-- Descrição: View pública que expõe id e nome de exibição da empresa para o fluxo de coleta sem login.
-- Uso: Caminho crítico do formulário público (QR Code) — resolve o nome da empresa.

-- public.enterprise_public
CREATE SCHEMA IF NOT EXISTS "public";

-- O nome de exibição vem de `public.user.name` (Better Auth), gravado no signup
-- (register.controller → provisionEnterpriseForUser). O fallback para
-- `auth.users.raw_user_meta_data->>'full_name'` cobre empresas legadas do fluxo
-- Supabase Auth (ex.: seed local A/B). LEFT JOIN nas duas fontes garante que TODA
-- empresa apareça (com INNER JOIN em auth.users, empresas Better Auth — que não
-- têm linha em auth.users — sumiriam e o formulário QR daria 404).
--
-- Consumidores (apenas id e name): public/enterprise.controller (reader do QR),
-- public/qrcode.controller (valida a empresa no envio anônimo) e
-- iaAnalyze.repository (nome da empresa no contexto de análise).
--
-- A view roda com os privilégios do OWNER (security_invoker = off — padrão do
-- Postgres): INTENCIONAL para o fluxo anônimo. NÃO habilite security_invoker = on.
CREATE OR REPLACE VIEW "public"."enterprise_public" AS
SELECT
  e.id,
  COALESCE(pu.name, au.raw_user_meta_data ->> 'full_name') AS name
FROM "public"."enterprise" e
LEFT JOIN "public"."user" pu ON pu.id = e.auth_user_id
LEFT JOIN "auth"."users" au ON au.id = e.auth_user_id;

-- Leitura liberada para o fluxo público (anon) e para usuários autenticados.
GRANT SELECT ON "public"."enterprise_public" TO anon, authenticated;
