// Relations — auth (user/session/account).
import { relations } from "drizzle-orm/relations";
import { user, session, account, enterprise } from "../schema.js";

export const userRelations = relations(user, ({many}) => ({
	enterprises: many(enterprise),
	sessions: many(session),
	accounts: many(account),
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
