// Relations — feedbacks, respostas, análise e insights.
import { relations } from "drizzle-orm/relations";
import { enterprise, catalogItems, questionsOfFeedbacks, feedbackQuestionSubquestions, feedback, feedbackQuestionAnswers, feedbackSubquestionAnswers, feedbackAnalysis, feedbackInsightsReport } from "../schema.js";

export const feedbackRelations = relations(feedback, ({one, many}) => ({
	enterprise: one(enterprise, {
		fields: [feedback.enterpriseId],
		references: [enterprise.id]
	}),
	feedbackQuestionAnswers: many(feedbackQuestionAnswers),
	feedbackSubquestionAnswers: many(feedbackSubquestionAnswers),
	feedbackAnalyses: many(feedbackAnalysis),
}));

export const feedbackQuestionAnswersRelations = relations(feedbackQuestionAnswers, ({one}) => ({
	feedback: one(feedback, {
		fields: [feedbackQuestionAnswers.feedbackId],
		references: [feedback.id]
	}),
	questionsOfFeedback: one(questionsOfFeedbacks, {
		fields: [feedbackQuestionAnswers.questionId],
		references: [questionsOfFeedbacks.id]
	}),
}));

export const feedbackSubquestionAnswersRelations = relations(feedbackSubquestionAnswers, ({one}) => ({
	feedback: one(feedback, {
		fields: [feedbackSubquestionAnswers.feedbackId],
		references: [feedback.id]
	}),
	feedbackQuestionSubquestion: one(feedbackQuestionSubquestions, {
		fields: [feedbackSubquestionAnswers.subquestionId],
		references: [feedbackQuestionSubquestions.id]
	}),
}));

export const feedbackAnalysisRelations = relations(feedbackAnalysis, ({one}) => ({
	feedback: one(feedback, {
		fields: [feedbackAnalysis.feedbackId],
		references: [feedback.id]
	}),
}));

export const feedbackInsightsReportRelations = relations(feedbackInsightsReport, ({one}) => ({
	enterprise: one(enterprise, {
		fields: [feedbackInsightsReport.enterpriseId],
		references: [enterprise.id]
	}),
	catalogItem: one(catalogItems, {
		fields: [feedbackInsightsReport.catalogItemId],
		references: [catalogItems.id]
	}),
}));
