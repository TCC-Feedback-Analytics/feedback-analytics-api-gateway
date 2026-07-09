// Schema Drizzle — Perguntas e pontos de coleta (questions_of_feedbacks/feedback_question_subquestions/collection_points).
import { pgTable, uniqueIndex, foreignKey, index, uuid, text, integer, timestamp, boolean, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { catalogItems, enterprise } from "./enterprise.js";

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
	index("idx_questions_context").using("btree", table.enterpriseId.asc().nullsLast(), table.scopeType.asc().nullsLast(), table.catalogItemId.asc().nullsLast(), table.isActive.asc().nullsLast()),
	uniqueIndex("uq_questions_company_order").using("btree", table.enterpriseId.asc().nullsLast(), table.questionOrder.asc().nullsLast()).where(sql`((scope_type = 'COMPANY'::text) AND (catalog_item_id IS NULL))`),
	uniqueIndex("uq_questions_item_order").using("btree", table.enterpriseId.asc().nullsLast(), table.scopeType.asc().nullsLast(), table.catalogItemId.asc().nullsLast(), table.questionOrder.asc().nullsLast()).where(sql`((scope_type = ANY (ARRAY['PRODUCT'::text, 'SERVICE'::text, 'DEPARTMENT'::text])) AND (catalog_item_id IS NOT NULL))`),
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
	check("questions_of_feedbacks_question_text_length_check", sql`(char_length(btrim(question_text)) >= 20) AND (char_length(btrim(question_text)) <= 150)`),
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
	index("idx_feedback_question_subquestions_active").using("btree", table.questionId.asc().nullsLast(), table.isActive.asc().nullsLast(), table.subquestionOrder.asc().nullsLast()),
	index("idx_feedback_question_subquestions_question_id").using("btree", table.questionId.asc().nullsLast()),
	foreignKey({
			columns: [table.questionId],
			foreignColumns: [questionsOfFeedbacks.id],
			name: "feedback_question_subquestions_question_id_fkey"
		}).onDelete("cascade"),
	unique("feedback_question_subquestions_question_order_unique").on(table.questionId, table.subquestionOrder),
	check("feedback_question_subquestions_order_check", sql`(subquestion_order >= 1) AND (subquestion_order <= 3)`),
	check("feedback_question_subquestions_text_length_check", sql`(char_length(btrim(subquestion_text)) >= 20) AND (char_length(btrim(subquestion_text)) <= 150)`),
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
	index("idx_collection_points_catalog_item_id").using("btree", table.catalogItemId.asc().nullsLast()),
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
