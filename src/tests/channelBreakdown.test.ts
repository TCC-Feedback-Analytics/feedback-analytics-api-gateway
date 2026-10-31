import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock('../db/client.js', () => ({ getDb: mocks.getDb, closeDb: vi.fn() }));

import { summarizeChannels } from '../libs/channelBreakdown.js';
import { fetchScopedRatingByChannel } from '../repositories/feedbackStats.repository.js';

describe('por onde chegaram as avaliações', () => {
  it('soma por canal, na ordem QR, link, NFC e sem marca, com a média das estrelas', () => {
    const summary = summarizeChannels([
      { channel: 'NFC', rating: 5, count: 3 },
      { channel: null, rating: 3, count: 2 },
      { channel: 'QR', rating: 4, count: 2 },
      { channel: 'QR', rating: 2, count: 2 },
    ]);
    expect(summary.map(({ channel, count, mean }) => ({ channel, count, mean }))).toEqual([
      { channel: 'QR', count: 4, mean: 3 },
      { channel: 'NFC', count: 3, mean: 5 },
      { channel: null, count: 2, mean: 3 },
    ]);
  });

  it('o teste do dono não vira canal, e canal sem avaliação não aparece', () => {
    expect(summarizeChannels([{ channel: 'TEST', rating: 5, count: 4 }])).toEqual([]);
  });

  it('feedback sem estrela conta no canal, sem média', () => {
    expect(summarizeChannels([{ channel: 'LINK', rating: null, count: 1 }])).toEqual([
      { channel: 'LINK', count: 1, mean: null, ci: null },
    ]);
  });
});

describe('consulta por canal', () => {
  const calls: { where?: SQL; groupBy?: unknown[] } = {};

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({
      select: () => ({
        from: () => ({
          where: (where: SQL) => {
            calls.where = where;
            return {
              groupBy: (...args: unknown[]) => {
                calls.groupBy = args;
                return Promise.resolve([{ channel: 'QR', rating: 5, c: '2' }]);
              },
            };
          },
        }),
      }),
    });
  });

  it('agrupa por canal e nota, sempre filtrando a empresa e o escopo', async () => {
    const rows = await fetchScopedRatingByChannel({ enterpriseId: 'ent-A', collectionPointIds: ['cp-A'], period: null });
    expect(rows).toEqual([{ channel: 'QR', rating: 5, count: 2 }]);
    expect(new PgDialect().sqlToQuery(calls.where as SQL).params).toEqual(['ent-A', 'cp-A']);
    expect(calls.groupBy).toHaveLength(2);
  });

  it('escopo sem pontos de coleta não consulta o banco', async () => {
    expect(await fetchScopedRatingByChannel({ enterpriseId: 'ent-A', collectionPointIds: [], period: null })).toEqual([]);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
});
