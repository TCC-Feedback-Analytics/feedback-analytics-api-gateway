// Schema Drizzle — Diagnóstico do escopo com IA.
//   - scope_diagnosis: cada diagnóstico gerado, por empresa, escopo, item e
//     período. Guarda o histórico (não sobrescreve) e o hash dos dados enviados
//     à IA: o mesmo recorte com os mesmos dados não paga IA de novo.
//     Isolamento multi-tenant: app-level por enterprise_id (ver ADR-0001).
import { pgTable, foreignKey, index, uuid, text, integer, timestamp, jsonb, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { catalogItems, enterprise } from "./enterprise.js";

export const scopeDiagnosis = pgTable("scope_diagnosis", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	enterpriseId: uuid("enterprise_id").notNull(),
	scopeType: text("scope_type").default('COMPANY').notNull(),
	catalogItemId: uuid("catalog_item_id"),
	periodStart: timestamp("period_start", { withTimezone: true, mode: 'string' }),
	periodEnd: timestamp("period_end", { withTimezone: true, mode: 'string' }),
	previousStart: timestamp("previous_start", { withTimezone: true, mode: 'string' }),
	previousEnd: timestamp("previous_end", { withTimezone: true, mode: 'string' }),
	/** Avaliações no período quando o diagnóstico foi gerado. */
	feedbackCount: integer("feedback_count").notNull(),
	/** sha256 do pacote enviado à IA (base do "já existe, não gera de novo"). */
	dataHash: text("data_hash").notNull(),
	model: text(),
	result: jsonb().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	// Último e histórico por escopo: WHERE enterprise/escopo/item ORDER BY created_at DESC.
	index("idx_scope_diagnosis_scope_created").using("btree", table.enterpriseId.asc().nullsLast(), table.scopeType.asc().nullsLast(), table.catalogItemId.asc().nullsLast(), table.createdAt.desc().nullsFirst()),
	foreignKey({
			columns: [table.enterpriseId],
			foreignColumns: [enterprise.id],
			name: "scope_diagnosis_enterprise_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.catalogItemId],
			foreignColumns: [catalogItems.id],
			name: "scope_diagnosis_catalog_item_id_fkey"
		}).onDelete("cascade"),
	check("scope_diagnosis_scope_type_check", sql`scope_type = ANY (ARRAY['COMPANY'::text, 'PRODUCT'::text, 'SERVICE'::text, 'DEPARTMENT'::text])`),
]);
