CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"id_token" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_items" (
	"enterprise_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "catalog_items_kind_check" CHECK (kind = ANY (ARRAY['PRODUCT'::text, 'SERVICE'::text, 'DEPARTMENT'::text])),
	CONSTRAINT "catalog_items_status_check" CHECK (status = ANY (ARRAY['ACTIVE'::text, 'INACTIVE'::text]))
);
--> statement-breakpoint
CREATE TABLE "collecting_data_enterprise" (
	"uses_company_products" boolean DEFAULT false NOT NULL,
	"uses_company_services" boolean DEFAULT false NOT NULL,
	"uses_company_departments" boolean DEFAULT false NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"company_objective" text,
	"analytics_goal" text,
	"business_summary" text,
	"main_products_or_services" text[],
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "collecting_data_enterprise_enterprise_unique" UNIQUE("enterprise_id")
);
--> statement-breakpoint
CREATE TABLE "collection_points" (
	"enterprise_id" uuid NOT NULL,
	"catalog_item_id" uuid,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"identifier" text,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "customer" (
	"name" text,
	"email" text,
	"gender" text,
	"enterprise_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "enterprise" (
	"document" text NOT NULL,
	"auth_user_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"account_type" text,
	"terms_version" text,
	"terms_accepted_at" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"subscription_status" text DEFAULT 'TRIAL',
	CONSTRAINT "enterprise_document_key" UNIQUE("document"),
	CONSTRAINT "enterprise_auth_user_id_key" UNIQUE("auth_user_id"),
	CONSTRAINT "enterprise_subscription_status_check" CHECK (subscription_status = ANY (ARRAY['TRIAL'::text, 'ACTIVE'::text, 'EXPIRED'::text, 'CANCELED'::text])),
	CONSTRAINT "enterprise_account_type_check" CHECK ((account_type IS NULL) OR (account_type = ANY (ARRAY['CPF'::text, 'CNPJ'::text])))
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"message" text NOT NULL,
	"rating" integer,
	"collection_point_id" uuid NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"tracked_device_id" uuid,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "feedback_analysis" (
	"sentiment" text,
	"categories" text[],
	"keywords" text[],
	"feedback_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"aspects" jsonb,
	"sentiment_score" numeric,
	"confidence" numeric
);
--> statement-breakpoint
CREATE TABLE "feedback_insights_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"scope_type" text DEFAULT 'COMPANY' NOT NULL,
	"catalog_item_id" uuid,
	"catalog_item_name" text,
	"summary" text,
	"recommendations" text[],
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "feedback_insights_report_scope_type_check" CHECK (scope_type = ANY (ARRAY['COMPANY'::text, 'PRODUCT'::text, 'SERVICE'::text, 'DEPARTMENT'::text]))
);
--> statement-breakpoint
CREATE TABLE "feedback_question_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feedback_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"question_text_snapshot" text NOT NULL,
	"answer_value" text NOT NULL,
	"answer_score" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_question_answers_feedback_question_unique" UNIQUE("feedback_id","question_id"),
	CONSTRAINT "feedback_question_answers_answer_value_check" CHECK (answer_value = ANY (ARRAY['PESSIMO'::text, 'RUIM'::text, 'MEDIANA'::text, 'BOA'::text, 'OTIMA'::text])),
	CONSTRAINT "feedback_question_answers_answer_score_check" CHECK ((answer_score >= 1) AND (answer_score <= 5))
);
--> statement-breakpoint
CREATE TABLE "feedback_question_subquestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"subquestion_order" integer NOT NULL,
	"subquestion_text" text NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_question_subquestions_question_order_unique" UNIQUE("question_id","subquestion_order"),
	CONSTRAINT "feedback_question_subquestions_order_check" CHECK ((subquestion_order >= 1) AND (subquestion_order <= 3)),
	CONSTRAINT "feedback_question_subquestions_text_length_check" CHECK ((char_length(btrim(subquestion_text)) >= 20) AND (char_length(btrim(subquestion_text)) <= 150))
);
--> statement-breakpoint
CREATE TABLE "feedback_subquestion_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feedback_id" uuid NOT NULL,
	"subquestion_id" uuid NOT NULL,
	"subquestion_text_snapshot" text NOT NULL,
	"answer_value" text NOT NULL,
	"answer_score" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_subquestion_answers_feedback_subquestion_unique" UNIQUE("feedback_id","subquestion_id"),
	CONSTRAINT "feedback_subquestion_answers_answer_value_check" CHECK (answer_value = ANY (ARRAY['PESSIMO'::text, 'RUIM'::text, 'MEDIANA'::text, 'BOA'::text, 'OTIMA'::text])),
	CONSTRAINT "feedback_subquestion_answers_answer_score_check" CHECK ((answer_score >= 1) AND (answer_score <= 5))
);
--> statement-breakpoint
CREATE TABLE "questions_of_feedbacks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"catalog_item_id" uuid,
	"question_order" integer NOT NULL,
	"question_text" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "questions_of_feedbacks_scope_type_check" CHECK (scope_type = ANY (ARRAY['COMPANY'::text, 'PRODUCT'::text, 'SERVICE'::text, 'DEPARTMENT'::text])),
	CONSTRAINT "questions_of_feedbacks_question_order_check" CHECK ((question_order >= 1) AND (question_order <= 3)),
	CONSTRAINT "questions_of_feedbacks_question_text_length_check" CHECK ((char_length(btrim(question_text)) >= 20) AND (char_length(btrim(question_text)) <= 150))
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_key" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "tracked_devices" (
	"enterprise_id" uuid NOT NULL,
	"customer_id" uuid,
	"device_fingerprint" text,
	"blocked_reason" text,
	"blocked_at" timestamp with time zone,
	"blocked_by" uuid,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_blocked" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"user_agent" text,
	"ip_address" "inet",
	"last_feedback_at" timestamp with time zone,
	"feedback_count" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_key" UNIQUE("email"),
	CONSTRAINT "user_phone_key" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_enterprise_id_fkey" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_points" ADD CONSTRAINT "collection_points_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_points" ADD CONSTRAINT "collection_points_enterprise_id_fkey" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise" ADD CONSTRAINT "enterprise_auth_user_id_user_fkey" FOREIGN KEY ("auth_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_enterprise_id_fkey" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_analysis" ADD CONSTRAINT "feedback_analysis_feedback_id_fkey" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_insights_report" ADD CONSTRAINT "feedback_insights_report_enterprise_id_fkey" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_insights_report" ADD CONSTRAINT "feedback_insights_report_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_question_answers" ADD CONSTRAINT "feedback_question_answers_feedback_id_fkey" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_question_answers" ADD CONSTRAINT "feedback_question_answers_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "public"."questions_of_feedbacks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_question_subquestions" ADD CONSTRAINT "feedback_question_subquestions_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "public"."questions_of_feedbacks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_subquestion_answers" ADD CONSTRAINT "feedback_subquestion_answers_feedback_id_fkey" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_subquestion_answers" ADD CONSTRAINT "feedback_subquestion_answers_subquestion_id_fkey" FOREIGN KEY ("subquestion_id") REFERENCES "public"."feedback_question_subquestions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions_of_feedbacks" ADD CONSTRAINT "questions_of_feedbacks_enterprise_id_fkey" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions_of_feedbacks" ADD CONSTRAINT "questions_of_feedbacks_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_devices" ADD CONSTRAINT "tracked_devices_enterprise_id_fkey" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_catalog_items_enterprise_kind" ON "catalog_items" USING btree ("enterprise_id","kind");--> statement-breakpoint
CREATE INDEX "idx_catalog_items_status" ON "catalog_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_collection_points_catalog_item_id" ON "collection_points" USING btree ("catalog_item_id");--> statement-breakpoint
CREATE INDEX "idx_feedback_insights_report_enterprise_updated" ON "feedback_insights_report" USING btree ("enterprise_id","updated_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_feedback_insights_context" ON "feedback_insights_report" USING btree ("enterprise_id","scope_type","catalog_item_id");--> statement-breakpoint
CREATE INDEX "idx_feedback_question_answers_feedback_id" ON "feedback_question_answers" USING btree ("feedback_id");--> statement-breakpoint
CREATE INDEX "idx_feedback_question_answers_question_id" ON "feedback_question_answers" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "idx_feedback_question_subquestions_active" ON "feedback_question_subquestions" USING btree ("question_id","is_active","subquestion_order");--> statement-breakpoint
CREATE INDEX "idx_feedback_question_subquestions_question_id" ON "feedback_question_subquestions" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "idx_feedback_subquestion_answers_feedback_id" ON "feedback_subquestion_answers" USING btree ("feedback_id");--> statement-breakpoint
CREATE INDEX "idx_feedback_subquestion_answers_subquestion_id" ON "feedback_subquestion_answers" USING btree ("subquestion_id");--> statement-breakpoint
CREATE INDEX "idx_questions_context" ON "questions_of_feedbacks" USING btree ("enterprise_id","scope_type","catalog_item_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_questions_company_order" ON "questions_of_feedbacks" USING btree ("enterprise_id","question_order") WHERE ((scope_type = 'COMPANY'::text) AND (catalog_item_id IS NULL));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_questions_item_order" ON "questions_of_feedbacks" USING btree ("enterprise_id","scope_type","catalog_item_id","question_order") WHERE ((scope_type = ANY (ARRAY['PRODUCT'::text, 'SERVICE'::text, 'DEPARTMENT'::text])) AND (catalog_item_id IS NOT NULL));--> statement-breakpoint
CREATE VIEW "public"."enterprise_public" AS (SELECT e.id, pu.name AS name FROM enterprise e LEFT JOIN "user" pu ON pu.id = e.auth_user_id);