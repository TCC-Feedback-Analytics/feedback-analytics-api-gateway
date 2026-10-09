ALTER TABLE "ia_analysis_job" DROP CONSTRAINT "ia_analysis_job_job_type_check";
--> statement-breakpoint
ALTER TABLE "ia_analysis_job" ADD CONSTRAINT "ia_analysis_job_job_type_check"
CHECK (job_type = ANY (ARRAY['analyze_raw'::text, 'regenerate_insights'::text, 'generate_company_questions'::text]));
