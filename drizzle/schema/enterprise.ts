// Schema Drizzle — Empresa e catálogo (enterprise/catalog_items/collecting_data_enterprise).
import { pgTable, foreignKey, index, uuid, text, integer, timestamp, boolean, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth.js";

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
	index("idx_catalog_items_enterprise_kind").using("btree", table.enterpriseId.asc().nullsLast(), table.kind.asc().nullsLast()),
	index("idx_catalog_items_status").using("btree", table.status.asc().nullsLast()),
	foreignKey({
			columns: [table.enterpriseId],
			foreignColumns: [enterprise.id],
			name: "catalog_items_enterprise_id_fkey"
		}).onDelete("cascade"),
	check("catalog_items_kind_check", sql`kind = ANY (ARRAY['PRODUCT'::text, 'SERVICE'::text, 'DEPARTMENT'::text])`),
	check("catalog_items_status_check", sql`status = ANY (ARRAY['ACTIVE'::text, 'INACTIVE'::text])`),
]);

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
