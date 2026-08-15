CREATE TABLE "enterprise_ia_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"provider" text DEFAULT 'openrouter' NOT NULL,
	"model" text,
	"api_key_ciphertext" text,
	"api_key_iv" text,
	"api_key_auth_tag" text,
	"key_hint" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "enterprise_ia_config_enterprise_unique" UNIQUE("enterprise_id"),
	CONSTRAINT "enterprise_ia_config_provider_check" CHECK (provider = ANY (ARRAY['gemini'::text, 'openrouter'::text]))
);
--> statement-breakpoint
ALTER TABLE "enterprise_ia_config" ADD CONSTRAINT "enterprise_ia_config_enterprise_id_fkey" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- SQL manual: updated_at automático no UPDATE (reusa a função do 0001; drizzle-kit não deriva triggers).
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.enterprise_ia_config FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();