import { and, eq, sql } from 'drizzle-orm';
import { userOnboarding } from '../../drizzle/schema.js';
import { getDb } from '../db/client.js';

export const SYSTEM_GUIDE_KEY = 'system-guide';
export const SYSTEM_GUIDE_VERSION = 1;
export type OnboardingStatus = 'completed' | 'skipped';

// Este domínio pertence ao usuário, não à empresa. Sempre usar o ID da sessão.
export async function getSystemGuide(userId: string): Promise<typeof userOnboarding.$inferSelect | null> {
  const rows = await getDb().select().from(userOnboarding).where(and(
    eq(userOnboarding.userId, userId),
    eq(userOnboarding.tourKey, SYSTEM_GUIDE_KEY),
    eq(userOnboarding.version, SYSTEM_GUIDE_VERSION),
  )).limit(1);
  return rows[0] ?? null;
}

export async function finishSystemGuide(userId: string, status: OnboardingStatus) {
  // Uma única instrução serializa conflitos na PK: completed sempre prevalece.
  // Repetições preservam finished_at; só skipped -> completed renova a data.
  const rows = await getDb().insert(userOnboarding).values({
    userId, tourKey: SYSTEM_GUIDE_KEY, version: SYSTEM_GUIDE_VERSION, status,
  }).onConflictDoUpdate({
    target: [userOnboarding.userId, userOnboarding.tourKey, userOnboarding.version],
    set: {
      status: sql`CASE WHEN ${userOnboarding.status} = 'completed' THEN 'completed' ELSE excluded.status END`,
      finishedAt: sql`CASE WHEN ${userOnboarding.status} = 'skipped' AND excluded.status = 'completed' THEN excluded.finished_at ELSE ${userOnboarding.finishedAt} END`,
    },
  }).returning();
  return rows[0]!;
}
