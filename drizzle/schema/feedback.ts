// Schema Drizzle — Feedbacks, respostas, análise e relatórios de insights.
import { pgTable, uniqueIndex, foreignKey, index, uuid, text, integer, timestamp, jsonb, numeric, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { catalogItems, enterprise } from "./enterprise.js";
import { feedbackQuestionSubquestions, questionsOfFeedbacks } from "./questions.js";

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
	index("idx_feedback_question_answers_feedback_id").using("btree", table.feedbackId.asc().nullsLast()),
	index("idx_feedback_question_answers_question_id").using("btree", table.questionId.asc().nullsLast()),
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
	index("idx_feedback_subquestion_answers_feedback_id").using("btree", table.feedbackId.asc().nullsLast()),
	index("idx_feedback_subquestion_answers_subquestion_id").using("btree", table.subquestionId.asc().nullsLast()),
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
	index("idx_feedback_insights_report_enterprise_updated").using("btree", table.enterpriseId.asc().nullsLast(), table.updatedAt.desc().nullsFirst()),
	uniqueIndex("uq_feedback_insights_context").using("btree", table.enterpriseId.asc().nullsLast(), table.scopeType.asc().nullsLast(), table.catalogItemId.asc().nullsLast()),
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
