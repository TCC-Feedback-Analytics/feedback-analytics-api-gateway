import { vi, describe, it, expect, beforeEach } from 'vitest';
import { IaAnalyzeServiceError } from '../libs/iaAnalyze/errors.js';
import { requestScopeDiagnosis } from '../services/scopeDiagnosis.service.js';
import { fetchEnterpriseContextForAnalysis } from '../repositories/iaAnalyze.repository.js';
import { fetchCatalogItemsByIds } from '../repositories/feedbackList.repository.js';
import { fetchScopedCommentCount } from '../repositories/feedbackStats.repository.js';
import { resolveScopeCollectionPointIds } from '../repositories/scope.repository.js';
import { enqueueIaJob } from '../repositories/iaJob.repository.js';
import { findScopeDiagnosisByHash } from '../repositories/scopeDiagnosis.repository.js';
import { resolveCompanyQuestionCreds } from '../services/companyQuestionSuggestions.service.js';
import {
  computeScopedAnalysis,
  computeScopedCustomers,
  computeScopedHeatmap,
  computeScopedStats,
  computeScopedTimeline,
} from '../services/scopeMetrics.service.js';
import { computeScopedQuestionMetrics } from '../services/questionMetrics.service.js';

vi.mock('../repositories/iaAnalyze.repository.js', () => ({ fetchEnterpriseContextForAnalysis: vi.fn() }));
vi.mock('../repositories/feedbackList.repository.js', () => ({ fetchCatalogItemsByIds: vi.fn() }));
vi.mock('../repositories/feedbackStats.repository.js', () => ({ fetchScopedCommentCount: vi.fn(), fetchScopedRatingAggregates: vi.fn() }));
vi.mock('../repositories/scope.repository.js', () => ({ resolveScopeCollectionPointIds: vi.fn() }));
vi.mock('../repositories/iaJob.repository.js', () => ({ enqueueIaJob: vi.fn() }));
vi.mock('../repositories/scopeDiagnosis.repository.js', () => ({ findScopeDiagnosisByHash: vi.fn(), insertScopeDiagnosis: vi.fn() }));
vi.mock('../services/companyQuestionSuggestions.service.js', () => ({ resolveCompanyQuestionCreds: vi.fn() }));
vi.mock('../services/scopeMetrics.service.js', () => ({
  computeScopedStats: vi.fn(), computeScopedAnalysis: vi.fn(), computeScopedTimeline: vi.fn(),
  computeScopedHeatmap: vi.fn(), computeScopedCustomers: vi.fn(),
}));
vi.mock('../services/questionMetrics.service.js', () => ({ computeScopedQuestionMetrics: vi.fn() }));
vi.mock('../libs/iaJob/kickWorker.js', () => ({ kickWorker: vi.fn(), kickWorkerIfPending: vi.fn() }));

const ENTERPRISE_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const ITEM_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const SEPTEMBER = { start: '2026-09-01T03:00:00.000Z', end: '2026-10-01T03:00:00.000Z' };

const base = {
  enterpriseId: ENTERPRISE_ID, userId: 'user-1', scopeType: 'COMPANY' as const, catalogItemId: null,
  period: SEPTEMBER, timeZone: 'America/Sao_Paulo', force: false,
};

function stats(total: number) {
  return {
    totalFeedbacks: total, totalAnalyzed: 0, starMean: 4, starMeanCI: { lower: 3.5, upper: 4.5 },
    ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: total, 5: 0 }, netSatisfaction: 100, csat: { pct: 100, ci: { lower: 70, upper: 100 } },
    confidenceTier: 'low',
  };
}

describe('pedido do diagnóstico do escopo', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(fetchEnterpriseContextForAnalysis).mockResolvedValue({
      enterpriseName: 'Padaria',
      collecting: { company_objective: 'Crescer', analytics_goal: 'Entender', business_summary: 'Padaria', main_products_or_services: [] },
    } as never);
    vi.mocked(resolveCompanyQuestionCreds).mockResolvedValue({ provider: 'openrouter', apiKey: 'test-only-key', model: 'modelo/teste' });
    vi.mocked(resolveScopeCollectionPointIds).mockResolvedValue({ error: false, ids: ['cp-1'] });
    vi.mocked(computeScopedStats).mockImplementation(async ({ period }) => stats(period.start === SEPTEMBER.start ? 14 : 6) as never);
    vi.mocked(computeScopedAnalysis).mockResolvedValue({ items: [], summary: { totalAnalyzed: 0, sentiments: { positive: 0, neutral: 0, negative: 0 }, topCategories: [], topKeywords: [] } });
    vi.mocked(computeScopedQuestionMetrics).mockResolvedValue([]);
    vi.mocked(fetchScopedCommentCount).mockResolvedValue(3);
    vi.mocked(computeScopedTimeline).mockResolvedValue([]);
    vi.mocked(computeScopedHeatmap).mockResolvedValue([]);
    vi.mocked(computeScopedCustomers).mockResolvedValue({ identified: 0 } as never);
    vi.mocked(findScopeDiagnosisByHash).mockResolvedValue(null);
    vi.mocked(enqueueIaJob).mockResolvedValue({ jobId: 'job-1', status: 'queued', deduped: false });
  });

  it('enfileira o job com o pacote do período e do anterior', async () => {
    const accepted = await requestScopeDiagnosis(base);

    expect(accepted).toEqual({ jobId: 'job-1', status: 'queued', deduped: false, cached: false, diagnosisId: null });
    const options = vi.mocked(enqueueIaJob).mock.calls[0][0].options as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(vi.mocked(enqueueIaJob).mock.calls[0][0]).toMatchObject({ jobType: 'generate_scope_diagnosis', scopeType: 'COMPANY', catalogItemId: null });
    expect(options.feedbackCount).toBe(14);
    expect(options.request.previous_period).toEqual({ start: '2026-08-02T03:00:00.000Z', end: '2026-09-01T03:00:00.000Z' });
    expect(options.request.previous.counts.total).toBe(6);
    expect(options.request.current.counts).toEqual({ total: 14, with_comment: 3, analyzed: 0, pending_analysis: 3 });
    expect(typeof options.dataHash).toBe('string');
  });

  it('devolve o diagnóstico guardado quando os dados não mudaram, sem enfileirar', async () => {
    vi.mocked(findScopeDiagnosisByHash).mockResolvedValue('diag-1');
    expect(await requestScopeDiagnosis(base)).toEqual({ jobId: null, status: 'completed', deduped: false, cached: true, diagnosisId: 'diag-1' });
    expect(enqueueIaJob).not.toHaveBeenCalled();
  });

  it('"gerar de novo" ignora o guardado', async () => {
    vi.mocked(findScopeDiagnosisByHash).mockResolvedValue('diag-1');
    await requestScopeDiagnosis({ ...base, force: true });
    expect(findScopeDiagnosisByHash).not.toHaveBeenCalled();
    expect(enqueueIaJob).toHaveBeenCalledTimes(1);
  });

  it('em todo o período, não compara', async () => {
    vi.mocked(computeScopedStats).mockResolvedValue(stats(30) as never);
    await requestScopeDiagnosis({ ...base, period: { start: null, end: null } });
    const options = vi.mocked(enqueueIaJob).mock.calls[0][0].options as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(options.request.previous_period).toBeNull();
    expect(options.request.previous).toBeNull();
  });

  it('recusa com menos de 10 avaliações no período', async () => {
    vi.mocked(computeScopedStats).mockResolvedValue(stats(9) as never);
    await expect(requestScopeDiagnosis(base)).rejects.toMatchObject({ statusCode: 422, code: 'insufficient_feedbacks_for_analysis' });
    expect(enqueueIaJob).not.toHaveBeenCalled();
  });

  it('recusa sem a configuração de IA da empresa', async () => {
    vi.mocked(resolveCompanyQuestionCreds).mockRejectedValue(new IaAnalyzeServiceError('ia_config_required', 409, 'ia_config_required'));
    await expect(requestScopeDiagnosis(base)).rejects.toMatchObject({ statusCode: 409, code: 'ia_config_required' });
    expect(computeScopedStats).not.toHaveBeenCalled();
  });

  it('recusa item de outro tipo ou de outra empresa', async () => {
    vi.mocked(fetchCatalogItemsByIds).mockResolvedValue([{ id: ITEM_ID, name: 'Pão', kind: 'SERVICE' }]);
    await expect(requestScopeDiagnosis({ ...base, scopeType: 'PRODUCT', catalogItemId: ITEM_ID }))
      .rejects.toMatchObject({ statusCode: 404, code: 'catalog_item_not_found' });
    vi.mocked(fetchCatalogItemsByIds).mockResolvedValue([]);
    await expect(requestScopeDiagnosis({ ...base, scopeType: 'PRODUCT', catalogItemId: ITEM_ID }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('leva o nome do item no pacote', async () => {
    vi.mocked(fetchCatalogItemsByIds).mockResolvedValue([{ id: ITEM_ID, name: 'Pão de queijo', kind: 'PRODUCT' }]);
    await requestScopeDiagnosis({ ...base, scopeType: 'PRODUCT', catalogItemId: ITEM_ID });
    const options = vi.mocked(enqueueIaJob).mock.calls[0][0].options as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(options.request.scope).toEqual({ scope_type: 'PRODUCT', catalog_item_id: ITEM_ID, catalog_item_name: 'Pão de queijo' });
  });
});
