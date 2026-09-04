import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), scope: vi.fn() }));
vi.mock('../db/client.js', () => ({ getDb: mocks.getDb }));
vi.mock('../repositories/scope.repository.js', () => ({ resolveScopeCollectionPointIds: mocks.scope }));
import { fetchFeedbacksForAnalysis, fetchAlreadyAnalyzedFeedbacks } from '../repositories/iaAnalyze.repository.js';

const offlineDb = drizzle.mock();
const query = {
  from: vi.fn(), leftJoin: vi.fn(), where: vi.fn(), orderBy: vi.fn(), limit: vi.fn(),
  then: (resolve: (rows: never[]) => unknown) => Promise.resolve([]).then(resolve),
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const name of ['from', 'leftJoin', 'where', 'orderBy', 'limit'] as const) query[name].mockReturnValue(query);
  mocks.scope.mockResolvedValue({ error: false, ids: ['cp-A'] });
  mocks.getDb.mockReturnValue({
    select: (fields: { x?: SQL }) => fields.x ? offlineDb.select({ x: fields.x }) : query,
  });
});

describe('seleção SQL dos pendentes', () => {
  it('exclui já analisados no WHERE, antes do LIMIT, preservando tenant e escopo', async () => {
    await fetchFeedbacksForAnalysis({ enterpriseId: 'ent-A', scopeType: 'COMPANY', onlyPending: true, limit: 50 });
    const compiled = new PgDialect().sqlToQuery(query.where.mock.calls[0][0] as SQL);
    expect(compiled.sql).toContain('not exists');
    expect(compiled.sql).toContain('"feedback_analysis"."feedback_id" = "feedback"."id"');
    expect(compiled.params).toEqual(['ent-A', 'cp-A']);
    expect(query.limit).toHaveBeenCalledWith(50);
    expect(query.where.mock.invocationCallOrder[0]).toBeLessThan(query.limit.mock.invocationCallOrder[0]);
    const ordering = new PgDialect().sqlToQuery(query.orderBy.mock.calls[0][0] as SQL);
    expect(ordering.sql).toContain('asc');
  });

  it('o fluxo sem limite não restringe o total de pendentes', async () => {
    await fetchFeedbacksForAnalysis({ enterpriseId: 'ent-A', onlyPending: true });
    expect(query.limit).not.toHaveBeenCalled();
  });

  it('consulta de já analisados mantém EXISTS e janela própria', async () => {
    await fetchAlreadyAnalyzedFeedbacks({ enterpriseId: 'ent-A', scopeType: 'PRODUCT', catalogItemId: 'product-A' });
    const compiled = new PgDialect().sqlToQuery(query.where.mock.calls[0][0] as SQL);
    expect(compiled.sql).toContain('exists');
    expect(compiled.sql).not.toContain('not exists');
    expect(query.limit).toHaveBeenCalledWith(100);
    expect(mocks.scope).toHaveBeenCalledWith({ enterpriseId: 'ent-A', scopeType: 'PRODUCT', catalogItemId: 'product-A' });
  });

  it('escopo vazio não cai em consulta de toda a empresa', async () => {
    mocks.scope.mockResolvedValue({ error: false, ids: [] });
    expect(await fetchFeedbacksForAnalysis({ enterpriseId: 'ent-A', onlyPending: true })).toEqual([]);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it('snapshot do relatório não aplica a janela legada de 100', async () => {
    await fetchAlreadyAnalyzedFeedbacks({ enterpriseId: 'ent-A', scopeType: 'COMPANY', all: true });
    expect(query.limit).not.toHaveBeenCalled();
  });

  it('recusa consulta sem tenant', async () => {
    await expect(fetchFeedbacksForAnalysis({ enterpriseId: '', onlyPending: true })).rejects.toThrow('enterprise_id');
  });
});
