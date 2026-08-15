CREATE TABLE "ia_analysis_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"job_type" text NOT NULL,
	"scope_type" text DEFAULT 'COMPANY' NOT NULL,
	"catalog_item_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"options" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error_code" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "ia_analysis_job_job_type_check" CHECK (job_type = ANY (ARRAY['analyze_raw'::text, 'regenerate_insights'::text])),
	CONSTRAINT "ia_analysis_job_scope_type_check" CHECK (scope_type = ANY (ARRAY['COMPANY'::text, 'PRODUCT'::text, 'SERVICE'::text, 'DEPARTMENT'::text])),
	CONSTRAINT "ia_analysis_job_status_check" CHECK (status = ANY (ARRAY['queued'::text, 'running'::text, 'waiting_budget'::text, 'completed'::text, 'failed'::text]))
);
--> statement-breakpoint
CREATE TABLE "ia_rate_budget" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text DEFAULT 'global' NOT NULL,
	"window_kind" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_ia_rate_budget_window" UNIQUE("scope","window_kind","window_start"),
	CONSTRAINT "ia_rate_budget_window_kind_check" CHECK (window_kind = ANY (ARRAY['minute'::text, 'day'::text]))
);
--> statement-breakpoint
ALTER TABLE "ia_analysis_job" ADD CONSTRAINT "ia_analysis_job_enterprise_id_fkey" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ia_analysis_job" ADD CONSTRAINT "ia_analysis_job_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ia_analysis_job_claim" ON "ia_analysis_job" USING btree ("status","next_run_at");--> statement-breakpoint
ALTER TABLE "feedback_analysis" ADD CONSTRAINT "feedback_analysis_feedback_id_unique" UNIQUE("feedback_id");--> statement-breakpoint
-- ── SQL manual (drizzle-kit não deriva índice por expressão nem triggers) ──
-- Dedup: no máximo 1 job ATIVO por (empresa, tipo, escopo, item). O COALESCE trata
-- o escopo COMPANY (catalog_item_id NULL) como chave única de verdade — sem ele o
-- Postgres consideraria cada NULL distinto e o duplo-clique passaria.
CREATE UNIQUE INDEX "uq_ia_analysis_job_active" ON "ia_analysis_job" USING btree ("enterprise_id","job_type","scope_type",COALESCE("catalog_item_id",'00000000-0000-0000-0000-000000000000'::uuid)) WHERE status IN ('queued','running','waiting_budget');--> statement-breakpoint
-- updated_at automático no UPDATE (reusa a função public.update_updated_at_column() do 0001).
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.ia_analysis_job FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();