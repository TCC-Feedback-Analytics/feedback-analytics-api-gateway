-- Tabelas core do Better Auth (user/session/account/verification) para o banco
-- LOCAL. Espelham src/auth/schema.ts: id uuid (default gen_random_uuid), colunas
-- snake_case. Usadas quando AUTH_PROVIDER=betterauth. "user" é palavra reservada
-- → sempre entre aspas.

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
