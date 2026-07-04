-- Shim de compatibilidade Supabase → Postgres vanilla (APENAS ambiente local).
--
-- O schema canônico (drizzle/0000_*.sql) foi introspectado do Supabase e usa
-- coisas que o Postgres puro não tem: o schema `auth`, a função `auth.uid()`
-- e os roles `anon`/`authenticated` (referenciados nas policies de RLS).
--
-- Este shim recria o mínimo para o schema aplicar e a RLS funcionar localmente,
-- SEM subir os containers do Supabase (GoTrue/Storage/Studio). `auth.uid()` lê
-- a variável de sessão `app.current_user_id`, então um teste/rota pode fazer
-- `SET app.current_user_id = '<uuid>'` para simular um usuário autenticado.
--
-- Em produção nada disso existe (o Supabase provê). Este arquivo é só para dev.

CREATE SCHEMA IF NOT EXISTS auth;

-- auth.uid(): retorna o UUID do "usuário atual" a partir da variável de sessão.
-- (No Supabase, viria do JWT. Aqui, de `SET app.current_user_id = ...`.)
CREATE OR REPLACE FUNCTION auth.uid()
  RETURNS uuid
  LANGUAGE sql
  STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$;

-- Roles referenciados pelas policies (TO anon / TO authenticated).
-- NOLOGIN: são apenas alvos de policy; o app conecta como `postgres` (superuser,
-- que ignora RLS — coerente com o design tenantScope: o filtro por enterprise_id
-- é feito na aplicação).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END
$$;
