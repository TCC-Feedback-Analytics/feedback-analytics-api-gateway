// Relations — enterprise (enterprise/catalog_items).
import { relations } from "drizzle-orm/relations";
import { user, enterprise, catalogItems, questionsOfFeedbacks, collectionPoints, feedback, feedbackInsightsReport, trackedDevices } from "../schema.js";

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
