// ─────────────────────────────────────────────────────────────────────────────
// FONTE ÚNICA DO SCHEMA (Drizzle) — reconciliado ao estado pós-cutover Better Auth.
//   Gerado por `db:pull` do banco canônico e re-baselined (ADR-0001, Fase 2 ·
//   docs/adr/0001-plano-fase2-rebaseline.md). Inclui as 4 tabelas do Better Auth
//   (user/session/account/verification), a FK enterprise.auth_user_id → public.user
//   (ON DELETE CASCADE) e SEM as policies RLS legadas.
//
//   Pendências da Fase 2:
//    - A view enterprise_public ainda faz LEFT JOIN em auth.users (fallback legado):
//      única referência a auth.users que resta — migrar no Passo 7.
//    - As tabelas Better Auth também vivem em src/auth/schema.ts (usado pelo
//      drizzleAdapter); consolidar numa definição só (Passo 2) — em andamento.
// ─────────────────────────────────────────────────────────────────────────────
import { pgTable, uuid, text, timestamp, unique, boolean, index, foreignKey, uniqueIndex, check, integer, jsonb, numeric, inet, pgView } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const verification = pgTable("verification", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	identifier: text().notNull(),
	value: text().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const collectingDataEnterprise = pgTable("collecting_data_enterprise", {
	usesCompanyProducts: boolean("uses_company_products").default(false).notNull(),
	usesCompanyServices: boolean("uses_company_services").default(false).notNull(),
	usesCompanyDepartments: boolean("uses_company_departments").default(false).notNull(),
	enterpriseId: uuid("enterprise_id").notNull(),
	companyObjective: text("company_objective"),
	analyticsGoal: text("analytics_goal"),
	businessSummary: text("business_summary"),
	mainProductsOrServices: text("main_products_or_services").array(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	unique("collecting_data_enterprise_enterprise_unique").on(table.enterpriseId),
]);

export const collectionPoints = pgTable("collection_points", {
	enterpriseId: uuid("enterprise_id").notNull(),
	catalogItemId: uuid("catalog_item_id"),
	name: text().notNull(),
	type: text().notNull(),
	identifier: text(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	status: text().default('ACTIVE').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_collection_points_catalog_item_id").using("btree", table.catalogItemId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.catalogItemId],
			foreignColumns: [catalogItems.id],
			name: "collection_points_catalog_item_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.enterpriseId],
			foreignColumns: [enterprise.id],
			name: "collection_points_enterprise_id_fkey"
		}).onDelete("cascade"),
]);

export const questionsOfFeedbacks = pgTable("questions_of_feedbacks", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	enterpriseId: uuid("enterprise_id").notNull(),
	scopeType: text("scope_type").notNull(),
	catalogItemId: uuid("catalog_item_id"),
	questionOrder: integer("question_order").notNull(),
	questionText: text("question_text").notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_questions_context").using("btree", table.enterpriseId.asc().nullsLast().op("text_ops"), table.scopeType.asc().nullsLast().op("text_ops"), table.catalogItemId.asc().nullsLast().op("bool_ops"), table.isActive.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("uq_questions_company_order").using("btree", table.enterpriseId.asc().nullsLast().op("int4_ops"), table.questionOrder.asc().nullsLast().op("uuid_ops")).where(sql`((scope_type = 'COMPANY'::text) AND (catalog_item_id IS NULL))`),
	uniqueIndex("uq_questions_item_order").using("btree", table.enterpriseId.asc().nullsLast().op("uuid_ops"), table.scopeType.asc().nullsLast().op("text_ops"), table.catalogItemId.asc().nullsLast().op("text_ops"), table.questionOrder.asc().nullsLast().op("text_ops")).where(sql`((scope_type = ANY (ARRAY['PRODUCT'::text, 'SERVICE'::text, 'DEPARTMENT'::text])) AND (catalog_item_id IS NOT NULL))`),
	foreignKey({
			columns: [table.enterpriseId],
			foreignColumns: [enterprise.id],
			name: "questions_of_feedbacks_enterprise_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.catalogItemId],
			foreignColumns: [catalogItems.id],
			name: "questions_of_feedbacks_catalog_item_id_fkey"
		}).onDelete("cascade"),
	check("questions_of_feedbacks_scope_type_check", sql`scope_type = ANY (ARRAY['COMPANY'::text, 'PRODUCT'::text, 'SERVICE'::text, 'DEPARTMENT'::text])`),
	check("questions_of_feedbacks_question_order_check", sql`(question_order >= 1) AND (question_order <= 3)`),
	check("questions_of_feedbacks_question_text_length_check", sql`(char_length(btrim(question_text)) >= 20) AND (char_length(btrim(question_text)) <= 150))) NOT VALID`),
]);

export const feedbackQuestionSubquestions = pgTable("feedback_question_subquestions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	questionId: uuid("question_id").notNull(),
	subquestionOrder: integer("subquestion_order").notNull(),
	subquestionText: text("subquestion_text").notNull(),
	isActive: boolean("is_active").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_feedback_question_subquestions_active").using("btree", table.questionId.asc().nullsLast().op("uuid_ops"), table.isActive.asc().nullsLast().op("int4_ops"), table.subquestionOrder.asc().nullsLast().op("bool_ops")),
	index("idx_feedback_question_subquestions_question_id").using("btree", table.questionId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.questionId],
			foreignColumns: [questionsOfFeedbacks.id],
			name: "feedback_question_subquestions_question_id_fkey"
		}).onDelete("cascade"),
	unique("feedback_question_subquestions_question_order_unique").on(table.questionId, table.subquestionOrder),
	check("feedback_question_subquestions_order_check", sql`(subquestion_order >= 1) AND (subquestion_order <= 3)`),
	check("feedback_question_subquestions_text_length_check", sql`(char_length(btrim(subquestion_text)) >= 20) AND (char_length(btrim(subquestion_text)) <= 150))) NOT VALID`),
]);

export const user = pgTable("user", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text(),
	email: text().notNull(),
	emailVerified: boolean("email_verified").default(false).notNull(),
	image: text(),
	phone: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("user_email_key").on(table.email),
	unique("user_phone_key").on(table.phone),
]);

export const enterprise = pgTable("enterprise", {
	document: text().notNull(),
	authUserId: uuid("auth_user_id").notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	accountType: text("account_type"),
	termsVersion: text("terms_version"),
	termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true, mode: 'string' }),
	trialEndsAt: timestamp("trial_ends_at", { withTimezone: true, mode: 'string' }),
	subscriptionStatus: text("subscription_status").default('TRIAL'),
}, (table) => [
	foreignKey({
			columns: [table.authUserId],
			foreignColumns: [user.id],
			name: "enterprise_auth_user_id_user_fkey"
		}).onDelete("cascade"),
	unique("enterprise_document_key").on(table.document),
	unique("enterprise_auth_user_id_key").on(table.authUserId),
	check("enterprise_subscription_status_check", sql`subscription_status = ANY (ARRAY['TRIAL'::text, 'ACTIVE'::text, 'EXPIRED'::text, 'CANCELED'::text])`),
	check("enterprise_account_type_check", sql`(account_type IS NULL) OR (account_type = ANY (ARRAY['CPF'::text, 'CNPJ'::text]))`),
]);

export const catalogItems = pgTable("catalog_items", {
	enterpriseId: uuid("enterprise_id").notNull(),
	kind: text().notNull(),
	name: text().notNull(),
	description: text(),
	status: text().default('ACTIVE').notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_catalog_items_enterprise_kind").using("btree", table.enterpriseId.asc().nullsLast().op("text_ops"), table.kind.asc().nullsLast().op("text_ops")),
	index("idx_catalog_items_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.enterpriseId],
			foreignColumns: [enterprise.id],
			name: "catalog_items_enterprise_id_fkey"
		}).onDelete("cascade"),
	check("catalog_items_kind_check", sql`kind = ANY (ARRAY['PRODUCT'::text, 'SERVICE'::text, 'DEPARTMENT'::text])`),
	check("catalog_items_status_check", sql`status = ANY (ARRAY['ACTIVE'::text, 'INACTIVE'::text])`),
]);

export const feedback = pgTable("feedback", {
	message: text().notNull(),
	rating: integer(),
	collectionPointId: uuid("collection_point_id").notNull(),
	enterpriseId: uuid("enterprise_id").notNull(),
	trackedDeviceId: uuid("tracked_device_id"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	foreignKey({
			columns: [table.enterpriseId],
			foreignColumns: [enterprise.id],
			name: "feedback_enterprise_id_fkey"
		}).onDelete("cascade"),
]);

export const feedbackQuestionAnswers = pgTable("feedback_question_answers", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	feedbackId: uuid("feedback_id").notNull(),
	questionId: uuid("question_id").notNull(),
	questionTextSnapshot: text("question_text_snapshot").notNull(),
	answerValue: text("answer_value").notNull(),
	answerScore: integer("answer_score").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_feedback_question_answers_feedback_id").using("btree", table.feedbackId.asc().nullsLast().op("uuid_ops")),
	index("idx_feedback_question_answers_question_id").using("btree", table.questionId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.feedbackId],
			foreignColumns: [feedback.id],
			name: "feedback_question_answers_feedback_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.questionId],
			foreignColumns: [questionsOfFeedbacks.id],
			name: "feedback_question_answers_question_id_fkey"
		}).onDelete("cascade"),
	unique("feedback_question_answers_feedback_question_unique").on(table.feedbackId, table.questionId),
	check("feedback_question_answers_answer_value_check", sql`answer_value = ANY (ARRAY['PESSIMO'::text, 'RUIM'::text, 'MEDIANA'::text, 'BOA'::text, 'OTIMA'::text])`),
	check("feedback_question_answers_answer_score_check", sql`(answer_score >= 1) AND (answer_score <= 5)`),
]);

export const feedbackSubquestionAnswers = pgTable("feedback_subquestion_answers", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	feedbackId: uuid("feedback_id").notNull(),
	subquestionId: uuid("subquestion_id").notNull(),
	subquestionTextSnapshot: text("subquestion_text_snapshot").notNull(),
	answerValue: text("answer_value").notNull(),
	answerScore: integer("answer_score").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_feedback_subquestion_answers_feedback_id").using("btree", table.feedbackId.asc().nullsLast().op("uuid_ops")),
	index("idx_feedback_subquestion_answers_subquestion_id").using("btree", table.subquestionId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.feedbackId],
			foreignColumns: [feedback.id],
			name: "feedback_subquestion_answers_feedback_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.subquestionId],
			foreignColumns: [feedbackQuestionSubquestions.id],
			name: "feedback_subquestion_answers_subquestion_id_fkey"
		}).onDelete("cascade"),
	unique("feedback_subquestion_answers_feedback_subquestion_unique").on(table.feedbackId, table.subquestionId),
	check("feedback_subquestion_answers_answer_value_check", sql`answer_value = ANY (ARRAY['PESSIMO'::text, 'RUIM'::text, 'MEDIANA'::text, 'BOA'::text, 'OTIMA'::text])`),
	check("feedback_subquestion_answers_answer_score_check", sql`(answer_score >= 1) AND (answer_score <= 5)`),
]);

export const feedbackAnalysis = pgTable("feedback_analysis", {
	sentiment: text(),
	categories: text().array(),
	keywords: text().array(),
	feedbackId: uuid("feedback_id").notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	aspects: jsonb(),
	sentimentScore: numeric("sentiment_score"),
	confidence: numeric(),
}, (table) => [
	foreignKey({
			columns: [table.feedbackId],
			foreignColumns: [feedback.id],
			name: "feedback_analysis_feedback_id_fkey"
		}).onDelete("cascade"),
]);

export const feedbackInsightsReport = pgTable("feedback_insights_report", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	enterpriseId: uuid("enterprise_id").notNull(),
	scopeType: text("scope_type").default('COMPANY').notNull(),
	catalogItemId: uuid("catalog_item_id"),
	catalogItemName: text("catalog_item_name"),
	summary: text(),
	recommendations: text().array(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_feedback_insights_report_enterprise_updated").using("btree", table.enterpriseId.asc().nullsLast().op("timestamptz_ops"), table.updatedAt.desc().nullsFirst().op("uuid_ops")),
	uniqueIndex("uq_feedback_insights_context").using("btree", table.enterpriseId.asc().nullsLast().op("text_ops"), table.scopeType.asc().nullsLast().op("uuid_ops"), table.catalogItemId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.enterpriseId],
			foreignColumns: [enterprise.id],
			name: "feedback_insights_report_enterprise_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.catalogItemId],
			foreignColumns: [catalogItems.id],
			name: "feedback_insights_report_catalog_item_id_fkey"
		}).onDelete("cascade"),
	check("feedback_insights_report_scope_type_check", sql`scope_type = ANY (ARRAY['COMPANY'::text, 'PRODUCT'::text, 'SERVICE'::text, 'DEPARTMENT'::text])`),
]);

export const customer = pgTable("customer", {
	name: text(),
	email: text(),
	gender: text(),
	enterpriseId: uuid("enterprise_id").notNull(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

export const trackedDevices = pgTable("tracked_devices", {
	enterpriseId: uuid("enterprise_id").notNull(),
	customerId: uuid("customer_id"),
	deviceFingerprint: text("device_fingerprint"),
	blockedReason: text("blocked_reason"),
	blockedAt: timestamp("blocked_at", { withTimezone: true, mode: 'string' }),
	blockedBy: uuid("blocked_by"),
	id: uuid().defaultRandom().primaryKey().notNull(),
	isBlocked: boolean("is_blocked").default(false),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	userAgent: text("user_agent"),
	ipAddress: inet("ip_address"),
	lastFeedbackAt: timestamp("last_feedback_at", { withTimezone: true, mode: 'string' }),
	feedbackCount: integer("feedback_count").default(0),
}, (table) => [
	foreignKey({
			columns: [table.enterpriseId],
			foreignColumns: [enterprise.id],
			name: "tracked_devices_enterprise_id_fkey"
		}).onDelete("cascade"),
]);

export const session = pgTable("session", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	token: text().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "session_user_id_fkey"
		}).onDelete("cascade"),
	unique("session_token_key").on(table.token),
]);

export const account = pgTable("account", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	accountId: text("account_id").notNull(),
	providerId: text("provider_id").notNull(),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true, mode: 'string' }),
	refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true, mode: 'string' }),
	scope: text(),
	idToken: text("id_token"),
	password: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "account_user_id_fkey"
		}).onDelete("cascade"),
]);
export const enterprisePublic = pgView("enterprise_public", {	id: uuid(),
	name: text(),
}).as(sql`SELECT e.id, COALESCE(pu.name, au.raw_user_meta_data ->> 'full_name'::text) AS name FROM enterprise e LEFT JOIN "user" pu ON pu.id = e.auth_user_id LEFT JOIN auth.users au ON au.id = e.auth_user_id`);