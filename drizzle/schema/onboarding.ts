import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, timestamp, primaryKey, check } from 'drizzle-orm/pg-core';
import { user } from './auth.js';

export const userOnboarding = pgTable('user_onboarding', {
  userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  tourKey: text('tour_key').notNull(),
  version: integer('version').notNull(),
  status: text('status').$type<'completed' | 'skipped'>().notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.tourKey, table.version] }),
  check('user_onboarding_status_check', sql`${table.status} IN ('completed', 'skipped')`),
  check('user_onboarding_version_check', sql`${table.version} > 0`),
]);
