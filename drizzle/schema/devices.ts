// Schema Drizzle — Clientes e dispositivos rastreados (anti-spam).
import { pgTable, foreignKey, uuid, text, integer, timestamp, boolean, inet } from "drizzle-orm/pg-core";
import { enterprise } from "./enterprise.js";

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
