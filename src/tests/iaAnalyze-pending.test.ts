import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IaAnalyzeFeedbackInput } from '@feedback/lib-shared/interfaces/contracts/ia-analyze/input.contract';

vi.mock('../repositories/iaAnalyze.repository.js', () => ({
  fetchEnterpriseContextForAnalysis: vi.fn(),
  fetchFeedbacksForAnalysis: vi.fn(),
  fetchAlreadyAnalyzedFeedbackIds: vi.fn(),
  fetchAlreadyAnalyzedFeedbacks: vi.fn(),
  fetchFeedbackInsightsReports: vi.fn(),
  insertFeedbackAnalysisRows: vi.fn(),
  upsertFeedbackInsightsReports: vi.fn(),
}));
vi.mock('../providers/iaAnalyze.provider.js', () => ({ runIaAnalyzeAnalysis: vi.fn() }));
vi.mock('../libs/iaConfig/resolveIaCreds.js', () => ({
  resolveIaCredsForEnterprise: vi.fn(), requireUserIaKey: () => false,
}));
import { prepareAnalyzeRawJob } from '../services/iaAnalyze.service.js';
import { fetchEnterpriseContextForAnalysis, fetchFeedbacksForAnalysis, fetchAlreadyAnalyzedFeedbackIds } from '../repositories/iaAnalyze.repository.js';
import { runIaAnalyzeAnalysis } from '../providers/iaAnalyze.provider.js';

const feedbacks = (count: number): IaAnalyzeFeedbackInput[] => Array.from({ length: count }, (_, i) => ({
  id: `feedback-${i}`, message: `Comentário ${i}`, rating: 4, created_at: null,
  scope_type: 'COMPANY', catalog_item: null, collection_point: null,
  dynamic_answers: [], dynamic_subanswers: [],
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('IA_MAX_FEEDBACKS_PER_BATCH', '20');
  vi.mocked(fetchEnterpriseContextForAnalysis).mockResolvedValue({
    enterpriseName: 'Restaurante',
    collecting: { company_objective: 'Melhorar', analytics_goal: 'Entender clientes', business_summary: 'Restaurante', main_products_or_services: ['Massas'] },
  });
  vi.mocked(fetchAlreadyAnalyzedFeedbackIds).mockResolvedValue(new Set());
});

describe('preparo da análise — todos os pendentes do escopo', () => {
  it('seleciona 102 pendentes sem corte em 50/100 e divide em lotes de 20', async () => {
    vi.mocked(fetchFeedbacksForAnalysis).mockResolvedValue(feedbacks(102));
    const result = await prepareAnalyzeRawJob({ enterpriseId: 'ent-A', options: { scope_type: 'COMPANY' } });
    expect(fetchFeedbacksForAnalysis).toHaveBeenCalledWith({ enterpriseId: 'ent-A', scopeType: 'COMPANY', catalogItemId: null, limit: undefined, onlyPending: true });
    expect(result?.allowedFeedbackIds.size).toBe(102);
    expect(result?.batches.map(b => b.feedbacks.length)).toEqual([20, 20, 20, 20, 20, 2]);
    expect(runIaAnalyzeAnalysis).not.toHaveBeenCalled();
  });

  it('retoma os últimos 2 pendentes se o escopo já tem 10 feedbacks', async () => {
    vi.mocked(fetchFeedbacksForAnalysis).mockResolvedValueOnce(feedbacks(2)).mockResolvedValueOnce(feedbacks(10));
    const result = await prepareAnalyzeRawJob({ enterpriseId: 'ent-A', options: { scope_type: 'COMPANY' }, remainingLimit: 2 });
    expect(result?.allowedFeedbackIds.size).toBe(2);
    expect(fetchFeedbacksForAnalysis).toHaveBeenNthCalledWith(2, expect.objectContaining({ limit: 10, scopeType: 'COMPANY' }));
  });

  it('preserva o mínimo quando o escopo inteiro tem só 9 feedbacks', async () => {
    vi.mocked(fetchFeedbacksForAnalysis).mockResolvedValue(feedbacks(9));
    await expect(prepareAnalyzeRawJob({ enterpriseId: 'ent-A' })).rejects.toMatchObject({ code: 'insufficient_feedbacks_for_analysis' });
  });

  it('nenhum pendente não chama IA nem exige um lote mínimo novo', async () => {
    vi.mocked(fetchFeedbacksForAnalysis).mockResolvedValue([]);
    expect(await prepareAnalyzeRawJob({ enterpriseId: 'ent-A' })).toBeNull();
    expect(fetchFeedbacksForAnalysis).toHaveBeenCalledTimes(1);
  });

  it('mantém limite explícito, escopo e item; retomada respeita saldo original', async () => {
    vi.mocked(fetchFeedbacksForAnalysis).mockResolvedValue([]);
    await prepareAnalyzeRawJob({ enterpriseId: 'ent-A', options: { limit: 500, scope_type: 'PRODUCT', catalog_item_id: ' item-A ' } });
    expect(fetchFeedbacksForAnalysis).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 100, onlyPending: true, scopeType: 'PRODUCT', catalogItemId: 'item-A' }));
    await prepareAnalyzeRawJob({ enterpriseId: 'ent-A', options: { limit: 100 }, remainingLimit: 12 });
    expect(fetchFeedbacksForAnalysis).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 12, onlyPending: true }));
  });

  it('não reenvia feedback que foi analisado entre seleção e preparo', async () => {
    vi.mocked(fetchFeedbacksForAnalysis).mockResolvedValue(feedbacks(10));
    vi.mocked(fetchAlreadyAnalyzedFeedbackIds).mockResolvedValue(new Set(['feedback-0']));
    const result = await prepareAnalyzeRawJob({ enterpriseId: 'ent-A' });
    expect(result?.allowedFeedbackIds.size).toBe(9);
    expect(result?.allowedFeedbackIds.has('feedback-0')).toBe(false);
  });
});
