-- CPF/CNPJ não é mais pedido nem guardado: o sistema não usa esse dado (LGPD, necessidade).
-- Remove também as funções antigas da migração do Supabase que liam a coluna (nenhum código as chama).
DROP FUNCTION IF EXISTS public.document_exists(text);--> statement-breakpoint
DROP FUNCTION IF EXISTS public.enterprise_public_documents_fn();--> statement-breakpoint
DROP FUNCTION IF EXISTS public.enterprise_public_ids_fn();--> statement-breakpoint
ALTER TABLE "enterprise" DROP CONSTRAINT "enterprise_document_key";--> statement-breakpoint
ALTER TABLE "enterprise" DROP CONSTRAINT "enterprise_account_type_check";--> statement-breakpoint
ALTER TABLE "enterprise" DROP COLUMN "document";--> statement-breakpoint
ALTER TABLE "enterprise" DROP COLUMN "account_type";