import { describe, it, expect, afterAll } from 'vitest';
import {
  fetchFeedbacksForAnalysis,
  fetchAlreadyAnalyzedFeedbacks,
  fetchAlreadyAnalyzedFeedbackIds,
  fetchEnterpriseContextForAnalysis,
  fetchFeedbackInsightsReports,
} from '../../repositories/iaAnalyze.repository.js';
import { closeDb } from '../../db/client.js';

// UUIDs fixos do seed (db/local/seed.sql).
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000001';
const FB_A1 = 'f0000000-0000-0000-0000-0000000000a1';
const FB_A2 = 'f0000000-0000-0000-0000-0000000000a2';
const FB_A4 = 'f0000000-0000-0000-0000-0000000000a4';

afterAll(async () => {
  await closeDb();
});

describe('[Integração] iaAnalyze.repository — escopo, análise e isolamento por tenant', () => {
  it('fetchFeedbacksForAnalysis: A=5, B=2 (isolados); shape IaAnalyzeFeedbackInput', async () => {
    const a = await fetchFeedbacksForAnalysis({ enterpriseId: A, limit: 50 });
    expect(a).toHaveLength(5);
    expect(a[0]?.collection_point).toBeDefined();
    expect(a[0]?.scope_type).toBe('COMPANY'); // ponto sem catalog_item
    expect(a.some((f) => f.dynamic_answers.length > 0)).toBe(true); // a1/a3 têm respostas

    expect(await fetchFeedbacksForAnalysis({ enterpriseId: B, limit: 50 })).toHaveLength(2);
  });

  it('fetchAlreadyAnalyzedFeedbacks: A=3 (só analisados), B=0', async () => {
    expect(await fetchAlreadyAnalyzedFeedbacks({ enterpriseId: A })).toHaveLength(3);
    expect(await fetchAlreadyAnalyzedFeedbacks({ enterpriseId: B })).toHaveLength(0);
  });

  it('restrição de escopo: PRODUCT (sem catálogo no seed) => []', async () => {
    expect(await fetchFeedbacksForAnalysis({ enterpriseId: A, limit: 50, scopeType: 'PRODUCT' })).toHaveLength(0);
    expect(await fetchAlreadyAnalyzedFeedbacks({ enterpriseId: A, scopeType: 'PRODUCT' })).toHaveLength(0);
  });

  it('fetchAlreadyAnalyzedFeedbackIds: distingue analisados de não-analisados', async () => {
    const ids = await fetchAlreadyAnalyzedFeedbackIds({ feedbackIds: [FB_A1, FB_A2, FB_A4] });
    expect(ids.has(FB_A1)).toBe(true);
    expect(ids.has(FB_A2)).toBe(true);
    expect(ids.has(FB_A4)).toBe(false); // a4 não tem análise no seed
  });

  it('fetchEnterpriseContextForAnalysis: A tem dados de coleta + nome (via enterprise_public)', async () => {
    const ctx = await fetchEnterpriseContextForAnalysis({ enterpriseId: A });
    expect(ctx.collecting).not.toBeNull();
    expect(ctx.collecting?.company_objective).toBeTruthy();
    expect(ctx.enterpriseName).toBe('Gestor A');
  });

  it('fetchFeedbackInsightsReports: A tem o relatório COMPANY do seed; B (PRODUCT) vazio', async () => {
    const aReports = await fetchFeedbackInsightsReports({ enterpriseId: A, scopeType: 'COMPANY' });
    expect(aReports).toHaveLength(1);
    expect(aReports[0]?.summary).toContain('atendimento');

    expect(await fetchFeedbackInsightsReports({ enterpriseId: B, scopeType: 'PRODUCT' })).toHaveLength(0);
  });
});
