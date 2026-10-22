// Schema Drizzle — Campo de comentário do formulário, por escopo.
//   - feedback_comment_field: o convite padrão, uma pergunta própria ou o campo
//     oculto, para a empresa (catalog_item_id NULL) ou para um item do catálogo.
//     Sem linha = convite padrão. Isolamento multi-tenant: app-level por
//     enterprise_id (ver ADR-0001), com a RLS ligada como defesa em profundidade.
import { pgTable, foreignKey, uniqueIndex, uuid, text, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { catalogItems, enterprise } from "./enterprise.js";

export const feedbackCommentField = pgTable("feedback_comment_field", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	enterpriseId: uuid("enterprise_id").notNull(),
	scopeType: text("scope_type").notNull(),
	catalogItemId: uuid("catalog_item_id"),
	mode: text().default('DEFAULT').notNull(),
	/** Só no modo CUSTOM: a pergunta no lugar do convite padrão. */
	prompt: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("uq_comment_field_company").using("btree", table.enterpriseId.asc().nullsLast()).where(sql`((scope_type = 'COMPANY'::text) AND (catalog_item_id IS NULL))`),
	uniqueIndex("uq_comment_field_item").using("btree", table.enterpriseId.asc().nullsLast(), table.catalogItemId.asc().nullsLast()).where(sql`(catalog_item_id IS NOT NULL)`),
	foreignKey({
			columns: [table.enterpriseId],
			foreignColumns: [enterprise.id],
			name: "feedback_comment_field_enterprise_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.catalogItemId],
			foreignColumns: [catalogItems.id],
			name: "feedback_comment_field_catalog_item_id_fkey"
		}).onDelete("cascade"),
	check("feedback_comment_field_scope_type_check", sql`scope_type = ANY (ARRAY['COMPANY'::text, 'PRODUCT'::text, 'SERVICE'::text, 'DEPARTMENT'::text])`),
	check("feedback_comment_field_mode_check", sql`mode = ANY (ARRAY['DEFAULT'::text, 'CUSTOM'::text, 'HIDDEN'::text])`),
	check("feedback_comment_field_prompt_check", sql`(mode <> 'CUSTOM'::text) OR ((prompt IS NOT NULL) AND (char_length(btrim(prompt)) >= 10) AND (char_length(btrim(prompt)) <= 150))`),
]).enableRLS();
