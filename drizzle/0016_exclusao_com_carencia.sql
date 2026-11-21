-- "Excluir minha conta" com 15 dias de carência: a data em que a conta será apagada.
-- NULL = conta ativa. O índice parcial serve à rotina diária, que só procura as contas marcadas.
ALTER TABLE "user" ADD COLUMN "deletion_scheduled_for" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "user_deletion_scheduled_for_idx" ON "user" USING btree ("deletion_scheduled_for") WHERE deletion_scheduled_for IS NOT NULL;