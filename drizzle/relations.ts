import { relations } from "drizzle-orm/relations";
import { catalogItems, collectionPoints, enterprise, questionsOfFeedbacks, feedbackQuestionSubquestions, user, feedback, feedbackQuestionAnswers, feedbackSubquestionAnswers, feedbackAnalysis, feedbackInsightsReport, trackedDevices, session, account } from "./schema";

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

export const catalogItemsRelations = relations(catalogItems, ({one, many}) => ({
	collectionPoints: many(collectionPoints),
	questionsOfFeedbacks: many(questionsOfFeedbacks),
	enterprise: one(enterprise, {
		fields: [catalogItems.enterpriseId],
		references: [enterprise.id]
	}),
	feedbackInsightsReports: many(feedbackInsightsReport),
}));

export const enterpriseRelations = relations(enterprise, ({one, many}) => ({
	collectionPoints: many(collectionPoints),
	questionsOfFeedbacks: many(questionsOfFeedbacks),
	user: one(user, {
		fields: [enterprise.authUserId],
		references: [user.id]
	}),
	catalogItems: many(catalogItems),
	feedbacks: many(feedback),
	feedbackInsightsReports: many(feedbackInsightsReport),
	trackedDevices: many(trackedDevices),
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

export const userRelations = relations(user, ({many}) => ({
	enterprises: many(enterprise),
	sessions: many(session),
	accounts: many(account),
}));

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

export const trackedDevicesRelations = relations(trackedDevices, ({one}) => ({
	enterprise: one(enterprise, {
		fields: [trackedDevices.enterpriseId],
		references: [enterprise.id]
	}),
}));

export const sessionRelations = relations(session, ({one}) => ({
	user: one(user, {
		fields: [session.userId],
		references: [user.id]
	}),
}));

export const accountRelations = relations(account, ({one}) => ({
	user: one(user, {
		fields: [account.userId],
		references: [user.id]
	}),
}));