-- Campo de comentário do formulário, por escopo: convite padrão, pergunta própria ou oculto.
-- Sem linha = convite padrão, então os formulários de hoje não mudam.
CREATE TABLE "feedback_comment_field" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"catalog_item_id" uuid,
	"mode" text DEFAULT 'DEFAULT' NOT NULL,
	"prompt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_comment_field_scope_type_check" CHECK (scope_type = ANY (ARRAY['COMPANY'::text, 'PRODUCT'::text, 'SERVICE'::text, 'DEPARTMENT'::text])),
	CONSTRAINT "feedback_comment_field_mode_check" CHECK (mode = ANY (ARRAY['DEFAULT'::text, 'CUSTOM'::text, 'HIDDEN'::text])),
	CONSTRAINT "feedback_comment_field_prompt_check" CHECK ((mode <> 'CUSTOM'::text) OR ((prompt IS NOT NULL) AND (char_length(btrim(prompt)) >= 10) AND (char_length(btrim(prompt)) <= 150)))
);
--> statement-breakpoint
ALTER TABLE "feedback_comment_field" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feedback_comment_field" ADD CONSTRAINT "feedback_comment_field_enterprise_id_fkey" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_comment_field" ADD CONSTRAINT "feedback_comment_field_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_comment_field_company" ON "feedback_comment_field" USING btree ("enterprise_id") WHERE ((scope_type = 'COMPANY'::text) AND (catalog_item_id IS NULL));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_comment_field_item" ON "feedback_comment_field" USING btree ("enterprise_id","catalog_item_id") WHERE (catalog_item_id IS NOT NULL);