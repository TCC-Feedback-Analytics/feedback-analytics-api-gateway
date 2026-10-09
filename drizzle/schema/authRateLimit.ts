import { pgTable, text, integer, timestamp, index } from 'drizzle-orm/pg-core';

export const authRateLimit = pgTable('auth_rate_limit', {
  key: text('key').primaryKey(),
  used: integer('used').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
}, (table) => [index('auth_rate_limit_expiry_idx').on(table.expiresAt)]).enableRLS();
