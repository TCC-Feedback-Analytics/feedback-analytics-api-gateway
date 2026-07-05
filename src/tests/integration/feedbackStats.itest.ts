import { describe, it, expect, afterAll } from 'vitest';
import {
  fetchScopedRatingAggregates,
  fetchScopedAnalysisAggregates,
} from '../../repositories/feedbackStats.repository.js';
import { closeDb } from '../../db/client.js';

// UUIDs fixos do seed (db/local/seed.sql).
const ENTERPRISE_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ENTERPRISE_B = 'bbbbbbbb-0000-0000-0000-000000000001';
const ENTERPRISE_GHOST = '00000000-0000-0000-0000-000000000000';

afterAll(async () => {
  await closeDb();
});

describe('[Integração] feedbackStats — agregados e isolamento por tenant', () => {
  it('Empresa A: agregados do seed (5 feedbacks 5/4/2/3/5, 3 analisados 2+/1−)', async () => {
    const rating = await fetchScopedRatingAggregates({
      enterpriseId: ENTERPRISE_A,
      collectionPointIds: null,
    });
    expect(rating.totalFeedbacks).toBe(5);
    expect(rating.ratingSum).toBe(19); // 5+4+2+3+5 → média 3.8
    expect(rating.ratingDistribution).toEqual({ 1: 0, 2: 1, 3: 1, 4: 1, 5: 2 });

    const analysis = await fetchScopedAnalysisAggregates({
      enterpriseId: ENTERPRISE_A,
      collectionPointIds: null,
    });
    expect(analysis.totalAnalyzed).toBe(3);
    expect(analysis.aiCounts).toEqual({ positive: 2, neutral: 0, negative: 1 });
  });

  it('Empresa B: agregados do seed (2 feedbacks 5/1 → média 3)', async () => {
    const rating = await fetchScopedRatingAggregates({
      enterpriseId: ENTERPRISE_B,
      collectionPointIds: null,
    });
    expect(rating.totalFeedbacks).toBe(2);
    expect(rating.ratingSum).toBe(6);
    expect(rating.ratingDistribution).toEqual({ 1: 1, 2: 0, 3: 0, 4: 0, 5: 1 });
  });

  it('ISOLAMENTO: A e B nunca enxergam os dados um do outro', async () => {
    const a = await fetchScopedRatingAggregates({ enterpriseId: ENTERPRISE_A, collectionPointIds: null });
    const b = await fetchScopedRatingAggregates({ enterpriseId: ENTERPRISE_B, collectionPointIds: null });

    // O seed tem 7 feedbacks no total (5 de A + 2 de B). Se algum tenant
    // enxergasse o do outro, o total escaparia de 5/2.
    expect(a.totalFeedbacks).toBe(5);
    expect(b.totalFeedbacks).toBe(2);
    expect(a.totalFeedbacks + b.totalFeedbacks).toBe(7);

    // Empresa inexistente => zero (não vaza nada de ninguém).
    const ghost = await fetchScopedRatingAggregates({
      enterpriseId: ENTERPRISE_GHOST,
      collectionPointIds: null,
    });
    expect(ghost.totalFeedbacks).toBe(0);
  });

  it('assertEnterpriseId barra query sem enterprise_id (fail-fast)', async () => {
    await expect(
      fetchScopedRatingAggregates({ enterpriseId: '', collectionPointIds: null }),
    ).rejects.toThrow(/enterprise_id/i);
  });
});
