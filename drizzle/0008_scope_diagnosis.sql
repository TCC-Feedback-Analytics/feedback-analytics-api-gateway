CREATE TABLE "scope_diagnosis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"scope_type" text DEFAULT 'COMPANY' NOT NULL,
	"catalog_item_id" uuid,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"previous_start" timestamp with time zone,
	"previous_end" timestamp with time zone,
	"feedback_count" integer NOT NULL,
	"data_hash" text NOT NULL,
	"model" text,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scope_diagnosis_scope_type_check" CHECK (scope_type = ANY (ARRAY['COMPANY'::text, 'PRODUCT'::text, 'SERVICE'::text, 'DEPARTMENT'::text]))
);
--> statement-breakpoint
ALTER TABLE "ia_analysis_job" DROP CONSTRAINT "ia_analysis_job_job_type_check";--> statement-breakpoint
ALTER TABLE "scope_diagnosis" ADD CONSTRAINT "scope_diagnosis_enterprise_id_fkey" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_diagnosis" ADD CONSTRAINT "scope_diagnosis_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_scope_diagnosis_scope_created" ON "scope_diagnosis" USING btree ("enterprise_id","scope_type","catalog_item_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
ALTER TABLE "ia_analysis_job" ADD CONSTRAINT "ia_analysis_job_job_type_check" CHECK (job_type = ANY (ARRAY['analyze_raw'::text, 'regenerate_insights'::text, 'generate_company_questions'::text, 'generate_scope_diagnosis'::text]));