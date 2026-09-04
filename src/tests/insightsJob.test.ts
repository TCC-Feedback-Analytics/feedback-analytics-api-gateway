import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginInsightsSynthesis,
  countInsightsJobSteps,
  prepareInsightsJob,
  runInsightsBatch,
  runInsightsSynthesis,
} from '../services/insightsJob.service.js';
import * as repo from '../repositories/iaAnalyze.repository.js';
import { runIaAnalyzeAnalysis, runIaInsightsSynthesis } from '../providers/iaAnalyze.provider.js';
vi.mock('../repositories/iaAnalyze.repository.js', () => ({
  fetchAlreadyAnalyzedFeedbacks: vi.fn(), fetchEnterpriseContextForAnalysis: vi.fn(),
  fetchFeedbackInsightsReports: vi.fn(), latestAnalysisForFeedbacks: vi.fn(),
}));
vi.mock('../providers/iaAnalyze.provider.js', () => ({ runIaAnalyzeAnalysis: vi.fn(), runIaInsightsSynthesis: vi.fn() }));
vi.mock('../libs/iaAnalyze/rules.js', () => ({ hasRequiredEnterpriseInfoForAnalysis: () => true, MIN_FEEDBACKS_FOR_RELEVANT_ANALYSIS: 10 }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(repo.fetchEnterpriseContextForAnalysis).mockResolvedValue({ collecting: null, enterpriseName: 'Empresa' });
  vi.mocked(repo.fetchAlreadyAnalyzedFeedbacks).mockResolvedValue(Array.from({ length: 105 }, (_, i) => ({
    id: 'f-' + i, message: 'Feedback teste', rating: 3, created_at: '2026-01-01', scope_type: 'COMPANY',
    catalog_item: null, collection_point: null, dynamic_answers: [], dynamic_subanswers: [],
  })));
  vi.mocked(repo.fetchFeedbackInsightsReports).mockResolvedValue([]);
  vi.mocked(repo.latestAnalysisForFeedbacks).mockResolvedValue('2026-09-01T12:00:00Z');
});
describe('síntese com snapshot de todos os analisados', () => {
  it('inclui 105 em seis lotes; escopo e tenant são passados ao repositório', async () => {
    const result = await prepareInsightsJob('tenant-A', { scope_type: 'COMPANY' });
    expect(result?.batches.map(b => b.feedbacks.length)).toEqual([20, 20, 20, 20, 20, 5]);
    expect(countInsightsJobSteps(result!)).toBe(7);
    expect(repo.fetchAlreadyAnalyzedFeedbacks).toHaveBeenCalledWith({ enterpriseId: 'tenant-A', scopeType: 'COMPANY', catalogItemId: null, all: true });
  });
  it('feedback antigo analisado agora invalida relatório anterior', async () => {
    vi.mocked(repo.fetchFeedbackInsightsReports).mockResolvedValue([{ scope_type: 'COMPANY', catalog_item_id: null,
      catalog_item_name: null, summary: 'Antigo', recommendations: [], updated_at: '2026-08-31T12:00:00Z' }]);
    expect(await prepareInsightsJob('tenant-A', { scope_type: 'COMPANY' })).not.toBeNull();
  });
  it('relatório realmente atualizado usa cache sem IA', async () => {
    vi.mocked(repo.fetchFeedbackInsightsReports).mockResolvedValue([{ scope_type: 'COMPANY', catalog_item_id: null,
      catalog_item_name: null, summary: 'Atual', recommendations: [], updated_at: '2026-09-02T12:00:00Z' }]);
    expect(await prepareInsightsJob('tenant-A', { scope_type: 'COMPANY' })).toBeNull();
    expect(await prepareInsightsJob('tenant-A', { scope_type: 'COMPANY', force: true })).not.toBeNull();
  });
  it('não usa relatório de outro escopo como cache', async () => {
    vi.mocked(repo.fetchFeedbackInsightsReports).mockResolvedValue([{ scope_type: 'PRODUCT', catalog_item_id: 'product-A',
      catalog_item_name: 'Produto', summary: 'Atual', recommendations: [], updated_at: '2026-09-02T12:00:00Z' }]);
    expect(await prepareInsightsJob('tenant-A', { scope_type: 'COMPANY' })).not.toBeNull();
  });
  it('um tick envia só o lote atual, preservando o modelo e a chave recebidos', async () => {
    const checkpoint = (await prepareInsightsJob('tenant-A', { scope_type: 'COMPANY' }))!;
    checkpoint.cursor = 5;
    vi.mocked(runIaAnalyzeAnalysis).mockResolvedValue({ analyses: checkpoint.batches[5].feedbacks.map(f => ({
      feedback_id: f.id, sentiment: 'positive', categories: [], keywords: [],
    })), contexts: [{ scope_type: 'COMPANY', catalog_item_id: null, catalog_item_name: null, analyzedCount: 5,
      globalInsights: { summary: 'Resumo final', recommendations: [] } }] });
    const creds = { provider: 'openrouter', apiKey: 'fake-test-key', model: 'test-model:free' };
    expect(await runInsightsBatch(checkpoint, creds)).toHaveLength(1);
    expect(runIaAnalyzeAnalysis).toHaveBeenCalledWith(expect.objectContaining({ batches: [expect.objectContaining({ feedbacks: checkpoint.batches[5].feedbacks })] }), creds);
  });
  it('resposta incompleta não pode virar checkpoint de sucesso', async () => {
    const checkpoint = (await prepareInsightsJob('tenant-A', { scope_type: 'COMPANY' }))!;
    vi.mocked(runIaAnalyzeAnalysis).mockResolvedValue({ analyses: [], contexts: [] });
    await expect(runInsightsBatch(checkpoint)).rejects.toMatchObject({ code: 'incomplete_ai_response' });
  });
  it('reduce final recebe os seis resumos e devolve um único contexto coeso', async () => {
    const prepared = (await prepareInsightsJob('tenant-A', { scope_type: 'COMPANY' }))!;
    prepared.contexts = prepared.batches.map((batch, index) => ({
      scope_type: 'COMPANY', catalog_item_id: null, catalog_item_name: null,
      analyzedCount: batch.feedbacks.length,
      globalInsights: { summary: `Resumo parcial ${index}`, recommendations: [`Ação ${index}`] },
    }));
    const checkpoint = beginInsightsSynthesis({ ...prepared, cursor: prepared.batches.length });
    vi.mocked(runIaInsightsSynthesis).mockResolvedValue({
      global_insights: { summary: 'Resumo final coeso', recommendations: ['Ação consolidada'] },
    });

    const result = await runInsightsSynthesis(checkpoint, { provider: 'openrouter', apiKey: 'test-key' });

    expect(result).toMatchObject({ analyzedCount: 105, globalInsights: { summary: 'Resumo final coeso' } });
    expect(runIaInsightsSynthesis).toHaveBeenCalledWith(expect.objectContaining({
      analyzed_count: 105,
      partial_insights: expect.arrayContaining([expect.objectContaining({ summary: 'Resumo parcial 0' })]),
    }), expect.anything());
  });
});
