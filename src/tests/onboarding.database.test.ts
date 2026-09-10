import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, inArray } from 'drizzle-orm';
import * as schema from '../../drizzle/schema.js';
import { getSystemGuide, finishSystemGuide } from '../repositories/onboarding.repository.js';

// Opt-in explícito: a suíte comum nunca conecta a um banco real.
const databaseUrl = process.env.ONBOARDING_TEST_DATABASE_URL;
const client = databaseUrl ? postgres(databaseUrl, { max: 3, prepare: false }) : null;
const db = client ? drizzle(client, { schema }) : null;
vi.mock('../db/client.js', () => ({ getDb: () => db! }));
const userA = randomUUID();
const userB = randomUUID();

describe.skipIf(!databaseUrl)('Onboarding — PostgreSQL real', () => {
  beforeAll(async () => {
    await db!.insert(schema.user).values([
      { id: userA, email: `${userA}@onboarding.invalid` },
      { id: userB, email: `${userB}@onboarding.invalid` },
    ]);
  });
  afterAll(async () => {
    try {
      await db!.delete(schema.user).where(inArray(schema.user.id, [userA, userB]));
    } finally {
      await client!.end();
    }
  });

  it('persiste, isola usuários/versões, preserva idempotência e resolve concorrência', async () => {
    expect(await getSystemGuide(userA)).toBeNull();
    const skipped = await finishSystemGuide(userA, 'skipped');
    expect((await getSystemGuide(userA))?.status).toBe('skipped');
    expect(await getSystemGuide(userB)).toBeNull();
    expect((await finishSystemGuide(userA, 'skipped')).finishedAt).toEqual(skipped.finishedAt);

    // Uma versão futura não altera a leitura da versão atual.
    await db!.insert(schema.userOnboarding).values({ userId: userB, tourKey: 'system-guide', version: 2, status: 'completed' });
    expect(await getSystemGuide(userB)).toBeNull();

    await Promise.all(Array.from({ length: 12 }, (_, i) => finishSystemGuide(userA, i % 2 ? 'completed' : 'skipped')));
    const completed = await getSystemGuide(userA);
    expect(completed?.status).toBe('completed');
    expect(completed!.finishedAt.getTime()).toBeGreaterThanOrEqual(skipped.finishedAt.getTime());
    expect((await finishSystemGuide(userA, 'skipped')).finishedAt).toEqual(completed!.finishedAt);
    expect((await finishSystemGuide(userA, 'completed')).finishedAt).toEqual(completed!.finishedAt);
    expect(await db!.select().from(schema.userOnboarding).where(eq(schema.userOnboarding.userId, userA))).toHaveLength(1);

    // Concorrência também na primeira criação, não só no UPDATE.
    await Promise.all([finishSystemGuide(userB, 'completed'), finishSystemGuide(userB, 'skipped')]);
    expect((await getSystemGuide(userB))?.status).toBe('completed');
  });

  it('impõe constraints e remove estado ao excluir o usuário', async () => {
    await expect(db!.insert(schema.userOnboarding).values({ userId: userA, tourKey: 'invalid-version', version: 0, status: 'completed' })).rejects.toThrow();
    await expect(client!`INSERT INTO user_onboarding (user_id, tour_key, version, status) VALUES (${userA}, 'invalid-status', 1, 'pending')`).rejects.toThrow();
    await expect(db!.insert(schema.userOnboarding).values({ userId: randomUUID(), tourKey: 'system-guide', version: 1, status: 'completed' })).rejects.toThrow();
    await db!.delete(schema.user).where(eq(schema.user.id, userA));
    expect(await getSystemGuide(userA)).toBeNull();
  });
});
