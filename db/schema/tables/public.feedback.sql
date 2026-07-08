-- Descrição: Feedback bruto recebido dos clientes.
-- Uso: Armazena mensagem/nota e vínculos com empresa, ponto de coleta e dispositivo.

-- public.feedback
CREATE SCHEMA IF NOT EXISTS "public";

CREATE TABLE IF NOT EXISTS "public"."feedback" (
  "message" text NOT NULL,
  "rating" integer,
  "collection_point_id" uuid NOT NULL,
  "enterprise_id" uuid NOT NULL,
  "tracked_device_id" uuid,
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'feedback_enterprise_id_fkey'
  ) THEN
    ALTER TABLE "public"."feedback"
      ADD CONSTRAINT "feedback_enterprise_id_fkey"
      FOREIGN KEY ("enterprise_id")
      REFERENCES "public"."enterprise"("id")
      ON DELETE CASCADE;
  END IF;
END
$$;

ALTER TABLE "public"."feedback" ENABLE ROW LEVEL SECURITY;

-- Triggers
DROP TRIGGER IF EXISTS "set_updated_at" ON "public"."feedback";
CREATE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."feedback"
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();


