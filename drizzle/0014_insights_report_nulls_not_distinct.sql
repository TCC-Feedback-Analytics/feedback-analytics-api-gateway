-- Relatório de insights: uma linha por escopo, também no escopo da empresa (catalog_item_id nulo).
-- O índice único da 0000 tratava NULL como distinto, o upsert não casava e cada geração gravava
-- uma linha nova. A leitura pega a mais recente, então a tela não mostrava o problema.

-- 1) Apaga as duplicadas, mantendo a mais recente de cada escopo.
DELETE FROM "feedback_insights_report" AS r
USING (
  SELECT "id", row_number() OVER (
    PARTITION BY "enterprise_id", "scope_type", "catalog_item_id"
    ORDER BY "updated_at" DESC NULLS LAST, "created_at" DESC NULLS LAST, "id" DESC
  ) AS "position"
  FROM "feedback_insights_report"
) AS ranked
WHERE r."id" = ranked."id" AND ranked."position" > 1;--> statement-breakpoint

-- 2) Troca o índice por uma constraint NULLS NOT DISTINCT. Bancos vindos do dump legado podem
-- já ter uma constraint com esse nome; os dois DROP cobrem os dois casos.
ALTER TABLE "feedback_insights_report" DROP CONSTRAINT IF EXISTS "uq_feedback_insights_context";--> statement-breakpoint
DROP INDEX IF EXISTS "uq_feedback_insights_context";--> statement-breakpoint
ALTER TABLE "feedback_insights_report" ADD CONSTRAINT "uq_feedback_insights_context" UNIQUE NULLS NOT DISTINCT("enterprise_id","scope_type","catalog_item_id");--> statement-breakpoint

-- 3) feedback_comment_field (0010) nasceu sem o trigger que mantém o updated_at das outras tabelas.
DROP TRIGGER IF EXISTS set_updated_at ON public.feedback_comment_field;--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.feedback_comment_field FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
