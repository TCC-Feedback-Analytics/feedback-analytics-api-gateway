// Relations — perguntas/pontos de coleta.
import { relations } from "drizzle-orm/relations";
import { enterprise, catalogItems, questionsOfFeedbacks, feedbackQuestionSubquestions, collectionPoints, feedbackQuestionAnswers, feedbackSubquestionAnswers } from "../schema.js";

export const collectionPointsRelations = relations(collectionPoints, ({one}) => ({
	catalogItem: one(catalogItems, {
		fields: [collectionPoints.catalogItemId],
		references: [catalogItems.id]
	}),
	enterprise: one(enterprise, {
		fields: [collectionPoints.enterpriseId],
		references: [enterprise.id]
	}),
}));

export const questionsOfFeedbacksRelations = relations(questionsOfFeedbacks, ({one, many}) => ({
	enterprise: one(enterprise, {
		fields: [questionsOfFeedbacks.enterpriseId],
		references: [enterprise.id]
	}),
	catalogItem: one(catalogItems, {
		fields: [questionsOfFeedbacks.catalogItemId],
		references: [catalogItems.id]
	}),
	feedbackQuestionSubquestions: many(feedbackQuestionSubquestions),
	feedbackQuestionAnswers: many(feedbackQuestionAnswers),
}));

export const feedbackQuestionSubquestionsRelations = relations(feedbackQuestionSubquestions, ({one, many}) => ({
	questionsOfFeedback: one(questionsOfFeedbacks, {
		fields: [feedbackQuestionSubquestions.questionId],
		references: [questionsOfFeedbacks.id]
	}),
	feedbackSubquestionAnswers: many(feedbackSubquestionAnswers),
}));
