// Schema Drizzle — Fila de análise assíncrona (etapa 03).
//   - ia_analysis_job: é ao mesmo tempo a FILA e o STATUS de progresso.
//     O worker puxa jobs com SELECT ... FOR UPDATE SKIP LOCKED (ver repo).
//     Isolamento multi-tenant: app-level por enterprise_id (a RLS foi removida
//     no cutover; ver ADR-0001) — toda query deve escopar por enterprise_id.
//   - ia_rate_budget: token bucket durável (janela de minuto/dia) para o
//     back-pressure contra a cota da IA.
//
// O índice PARCIAL ÚNICO de dedup (jobs ativos) e os triggers set_updated_at
// NÃO são derivados pelo drizzle-kit — entram como SQL manual na migration 0002
// (mesmo padrão do 0001).
import { pgTable, foreignKey, index, uuid, text, integer, timestamp, jsonb, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { catalogItems, enterprise } from "./enterprise.js";

export const iaAnalysisJob = pgTable("ia_analysis_job", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	enterpriseId: uuid("enterprise_id").notNull(),
	jobType: text("job_type").notNull(),
	scopeType: text("scope_type").default('COMPANY').notNull(),
	catalogItemId: uuid("catalog_item_id"),
	status: text().default('queued').notNull(),
	total: integer().default(0).notNull(),
	done: integer().default(0).notNull(),
	options: jsonb(),
	attempts: integer().default(0).notNull(),
	nextRunAt: timestamp("next_run_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	errorCode: text("error_code"),
	requestedBy: uuid("requested_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	// Claim do worker: WHERE status=? AND next_run_at<=now() ORDER BY created_at.
	index("idx_ia_analysis_job_claim").using("btree", table.status.asc().nullsLast(), table.nextRunAt.asc().nullsLast()),
	foreignKey({
			columns: [table.enterpriseId],
			foreignColumns: [enterprise.id],
			name: "ia_analysis_job_enterprise_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.catalogItemId],
			foreignColumns: [catalogItems.id],
			name: "ia_analysis_job_catalog_item_id_fkey"
		}).onDelete("cascade"),
	check("ia_analysis_job_job_type_check", sql`job_type = ANY (ARRAY['analyze_raw'::text, 'regenerate_insights'::text])`),
	check("ia_analysis_job_scope_type_check", sql`scope_type = ANY (ARRAY['COMPANY'::text, 'PRODUCT'::text, 'SERVICE'::text, 'DEPARTMENT'::text])`),
	check("ia_analysis_job_status_check", sql`status = ANY (ARRAY['queued'::text, 'running'::text, 'waiting_budget'::text, 'completed'::text, 'failed'::text])`),
	// NB: o índice PARCIAL ÚNICO de dedup (jobs ativos) usa COALESCE(catalog_item_id)
	// e é criado à mão na migration 0002 (drizzle-kit não deriva índice por expressão).
]);

export const iaRateBudget = pgTable("ia_rate_budget", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	// 'global' hoje (chave da IA compartilhada); a etapa 04 (BYO-key) usa o
	// enterprise_id como escopo, sem tocar no schema.
	scope: text().default('global').notNull(),
	windowKind: text("window_kind").notNull(),
	windowStart: timestamp("window_start", { withTimezone: true, mode: 'string' }).notNull(),
	used: integer().default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	// Habilita o upsert atômico de reserva (ON CONFLICT ... DO UPDATE ... WHERE used < limite).
	unique("uq_ia_rate_budget_window").on(table.scope, table.windowKind, table.windowStart),
	check("ia_rate_budget_window_kind_check", sql`window_kind = ANY (ARRAY['minute'::text, 'day'::text])`),
]);
