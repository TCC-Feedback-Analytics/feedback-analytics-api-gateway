import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IaAnalyzeFeedbackInput } from '@feedback/lib-shared/interfaces/contracts/ia-analyze/input.contract';
import { assertCompleteAnalyses } from '../libs/iaAnalyze/validateCompletion.js';

vi.mock('../repositories/iaAnalyze.repository.js', () => ({
  fetchEnterpriseContextForAnalysis: vi.fn(), fetchFeedbacksForAnalysis: vi.fn(),
  fetchAlreadyAnalyzedFeedbackIds: vi.fn(), fetchAlreadyAnalyzedFeedbacks: vi.fn(),
  fetchFeedbackInsightsReports: vi.fn(), insertFeedbackAnalysisRows: vi.fn(), upsertFeedbackInsightsReports: vi.fn(),
}));
vi.mock('../providers/iaAnalyze.provider.js', () => ({ runIaAnalyzeAnalysis: vi.fn() }));
vi.mock('../libs/iaConfig/resolveIaCreds.js', () => ({ resolveIaCredsForEnterprise: vi.fn(async () => undefined), requireUserIaKey: () => false }));

import { analyzeRawFeedbacks, runOneBatch } from '../services/iaAnalyze.service.js';
import { fetchEnterpriseContextForAnalysis, fetchFeedbacksForAnalysis, fetchAlreadyAnalyzedFeedbackIds, insertFeedbackAnalysisRows } from '../repositories/iaAnalyze.repository.js';
import { runIaAnalyzeAnalysis } from '../providers/iaAnalyze.provider.js';

const feedbacks: IaAnalyzeFeedbackInput[] = Array.from({ length: 10 }, (_, i) => ({
  id: `fb-${i}`, message: 'Ótimo', rating: 5, created_at: null, scope_type: 'COMPANY', collection_point: null, catalog_item: null, dynamic_answers: [], dynamic_subanswers: [],
}));
const analyses = feedbacks.map(f => ({ feedback_id: f.id, sentiment: 'positive' as const, categories: [], keywords: [] }));
const expectedIds = new Set(feedbacks.map(f => f.id));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchEnterpriseContextForAnalysis).mockResolvedValue({ enterpriseName: 'Teste', collecting: { company_objective: 'Meta', analytics_goal: 'Meta', business_summary: 'Resumo', main_products_or_services: [] } });
  vi.mocked(fetchFeedbacksForAnalysis).mockResolvedValue(feedbacks);
  vi.mocked(fetchAlreadyAnalyzedFeedbackIds).mockResolvedValue(new Set());
});

describe('Gateway não confia em HTTP 200 incompleto', () => {
  it.each(['sync', 'worker'])('%s: não persiste nem confirma resposta parcial', async mode => {
    vi.mocked(runIaAnalyzeAnalysis).mockResolvedValue({ analyses: analyses.slice(0, 9), contexts: [] });
    const result = mode === 'sync' ? analyzeRawFeedbacks({ enterpriseId: 'ent-A' }) : runOneBatch({
      enterpriseContext: { enterprise_name: 'Teste' } as Parameters<typeof runOneBatch>[0]['enterpriseContext'],
      batch: { scopeType: 'COMPANY', catalogItemId: null, catalogItemName: null, feedbacks }, allowedFeedbackIds: expectedIds,
    });
    await expect(result).rejects.toMatchObject({ code: 'incomplete_ai_response' });
    expect(insertFeedbackAnalysisRows).not.toHaveBeenCalled();
  });

  it('conclusão válida continua persistindo todos os resultados', async () => {
    vi.mocked(runIaAnalyzeAnalysis).mockResolvedValue({ analyses, contexts: [] });
    vi.mocked(insertFeedbackAnalysisRows).mockResolvedValue(analyses.map(a => ({ id: a.feedback_id, ...a })));
    expect((await analyzeRawFeedbacks({ enterpriseId: 'ent-A' })).analyzedCount).toBe(10);
    expect(insertFeedbackAnalysisRows).toHaveBeenCalledOnce();
  });

  it('worker valida IDs do lote atual, não só a lista global do job', async () => {
    vi.mocked(runIaAnalyzeAnalysis).mockResolvedValue({ analyses: [analyses[1]], contexts: [] });
    await expect(runOneBatch({
      enterpriseContext: { enterprise_name: 'Teste' } as Parameters<typeof runOneBatch>[0]['enterpriseContext'],
      batch: { scopeType: 'COMPANY', catalogItemId: null, catalogItemName: null, feedbacks: [feedbacks[0]] }, allowedFeedbackIds: expectedIds,
    })).rejects.toMatchObject({ code: 'invalid_ai_response_schema' });
    expect(insertFeedbackAnalysisRows).not.toHaveBeenCalled();
  });

  it.each([null, [null], [...analyses, analyses[0]], [{ ...analyses[0], feedback_id: 'foreign-id' }], [{ ...analyses[0], sentiment: 'wrong' }]])('rejeita IDs duplicados/externos e formato inválido: %j', value => {
    expect(() => assertCompleteAnalyses(value, expectedIds)).toThrow();
  });
});
