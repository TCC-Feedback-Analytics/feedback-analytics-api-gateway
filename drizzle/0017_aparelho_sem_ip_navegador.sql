-- O aparelho que envia o formulário público passa a ser só o HMAC em device_fingerprint. O navegador e o IP
-- serviam para calculá-lo, mas eram gravados a cada envio e nada os lia (LGPD, art. 6º, III: necessidade).
-- A função antiga register_device_feedback, da época do Supabase e sem uso no código, gravava nessas colunas.
ALTER TABLE "tracked_devices" DROP COLUMN "user_agent";--> statement-breakpoint
ALTER TABLE "tracked_devices" DROP COLUMN "ip_address";--> statement-breakpoint
DROP FUNCTION IF EXISTS public.register_device_feedback(uuid, text, text, inet, uuid, uuid);
