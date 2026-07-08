-- Descrição: Resultado da análise de feedback (sentimento/categorias/keywords).
-- Uso: Camada analítica derivada de cada registro de feedback.

-- public.feedback_analysis
CREATE SCHEMA IF NOT EXISTS "public";

CREATE TABLE IF NOT EXISTS "public"."feedback_analysis" (
  "sentiment" text,
  "categories" text[],
  "keywords" text[],
  "feedback_id" uuid NOT NULL,
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
    WHERE conname = 'feedback_analysis_feedback_id_fkey'
  ) THEN
    ALTER TABLE "public"."feedback_analysis"
      ADD CONSTRAINT "feedback_analysis_feedback_id_fkey"
      FOREIGN KEY ("feedback_id")
      REFERENCES "public"."feedback"("id")
      ON DELETE CASCADE;
  END IF;
END
$$;

-- Colunas do Tier 2 (ABSA + intensidade graduada + confiança). Idempotente.
ALTER TABLE "public"."feedback_analysis" ADD COLUMN IF NOT EXISTS "aspects" jsonb;
ALTER TABLE "public"."feedback_analysis" ADD COLUMN IF NOT EXISTS "sentiment_score" numeric;
ALTER TABLE "public"."feedback_analysis" ADD COLUMN IF NOT EXISTS "confidence" numeric;

ALTER TABLE "public"."feedback_analysis" ENABLE ROW LEVEL SECURITY;

-- Triggers
DROP TRIGGER IF EXISTS "set_updated_at" ON "public"."feedback_analysis";
CREATE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."feedback_analysis"
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();


