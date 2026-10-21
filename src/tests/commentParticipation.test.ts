import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { summarizeCommentParticipation } from '../libs/commentParticipation.js';

const { getDb } = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock('../db/client.js', () => ({ getDb, closeDb: vi.fn() }));
import { fetchScopedRatingByComment } from '../repositories/feedbackStats.repository.js';

describe('participação nos comentários', () => {
  it('taxa de quem comentou e a nota de cada grupo', () => {
    const summary = summarizeCommentParticipation([
      { hasComment: true, rating: 1, count: 2 },
      { hasComment: true, rating: 2, count: 2 },
      { hasComment: false, rating: 5, count: 6 },
    ]);
    expect(summary).toMatchObject({ total: 10, withComment: 4, pct: 40, confidenceTier: 'low' });
    expect(summary.ci.lower).toBeLessThan(40);
    expect(summary.ci.upper).toBeGreaterThan(40);
    expect(summary.withCommentRating).toMatchObject({ n: 4, mean: 1.5 });
    expect(summary.withoutCommentRating).toMatchObject({ n: 6, mean: 5 });
  });

  it('sem avaliações: 0% e grupos vazios', () => {
    expect(summarizeCommentParticipation([])).toEqual({
      total: 0, withComment: 0, pct: 0, ci: { lower: 0, upper: 0 }, confidenceTier: 'insufficient',
      withCommentRating: null, withoutCommentRating: null,
    });
  });

  it('agrupa no banco por "tem comentário" e nota, sempre filtrando a empresa', async () => {
    const calls: { where?: SQL; groupBy?: unknown[] } = {};
    const chain = {
      from: () => chain,
      where: (where: SQL) => { calls.where = where; return chain; },
      groupBy: (...args: unknown[]) => { calls.groupBy = args; return Promise.resolve([{ hasComment: true, rating: 4, c: '3' }]); },
    };
    getDb.mockReturnValue({ select: () => chain });

    const rows = await fetchScopedRatingByComment({ enterpriseId: 'ent-A', collectionPointIds: ['cp-A'], period: null });

    expect(rows).toEqual([{ hasComment: true, rating: 4, count: 3 }]);
    const where = new PgDialect().sqlToQuery(calls.where as SQL);
    expect(where.params).toEqual(['ent-A', 'cp-A']);
    const group = new PgDialect().sqlToQuery(calls.groupBy?.[0] as SQL);
    expect(group.sql).toBe('length(trim("feedback"."message")) > 0');
  });

  it('escopo sem pontos de coleta não consulta o banco', async () => {
    getDb.mockClear();
    expect(await fetchScopedRatingByComment({ enterpriseId: 'ent-A', collectionPointIds: [], period: null })).toEqual([]);
    expect(getDb).not.toHaveBeenCalled();
  });
});
