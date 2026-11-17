import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PARTIALS_PER_SYNTHESIS,
  MAX_SYNTHESIS_BODY_BYTES,
  beginInsightsSynthesis,
  countInsightsJobSteps,
  countRemainingSynthesisSteps,
  prepareInsightsJob,
  runInsightsBatch,
  runInsightsSynthesis,
  type IaJobCheckpoint,
} from '../services/insightsJob.service.js';
import type { IaInsightsSynthesisRequest } from '@feedback/lib-shared/interfaces/contracts/ia-analyze/insights-synthesis.contract';
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

    expect(result.cursor).toBe(1);
    expect(result.synthesizedContexts).toEqual([expect.objectContaining({
      analyzedCount: 105, globalInsights: expect.objectContaining({ summary: 'Resumo final coeso' }),
    })]);
    expect(runIaInsightsSynthesis).toHaveBeenCalledWith(expect.objectContaining({
      analyzed_count: 105,
      partial_insights: expect.arrayContaining([expect.objectContaining({ summary: 'Resumo parcial 0' })]),
    }), expect.anything());
  });
});

/** Um relatório com `count` insights parciais, cada um vindo de um lote de 20 feedbacks. */
function checkpointWithPartials(count: number, summary = (index: number) => `Resumo parcial ${index}`): IaJobCheckpoint {
  return beginInsightsSynthesis({
    phase: 'generating', enterpriseContext: { enterprise_name: 'Empresa', company_objective: null,
      analytics_goal: null, business_summary: null, main_products_or_services: null },
    batches: [], cursor: 0, startedAt: '2026-09-01T12:00:00Z',
    contexts: Array.from({ length: count }, (_, index) => ({
      scope_type: 'COMPANY', catalog_item_id: null, catalog_item_name: null, analyzedCount: 20,
      globalInsights: { summary: summary(index), recommendations: [`Ação ${index}`] },
    })),
  });
}

/** Roda a síntese como o worker: uma chamada por passo, até publicar o relatório. */
async function synthesizeReport(checkpoint: IaJobCheckpoint) {
  let current = checkpoint;
  let steps = 0;
  while (current.cursor < current.synthesisTargets!.length) {
    expect(countRemainingSynthesisSteps(current)).toBeGreaterThan(0);
    current = await runInsightsSynthesis(current);
    steps += 1;
    if (steps > 50) throw new Error('síntese não terminou');
  }
  expect(countRemainingSynthesisSteps(current)).toBe(0);
  const requests = vi.mocked(runIaInsightsSynthesis).mock.calls.map(([request]) => request as IaInsightsSynthesisRequest);
  return { report: current.synthesizedContexts!, requests };
}

describe('síntese em rodadas acima de 100 parciais', () => {
  beforeEach(() => {
    vi.mocked(runIaInsightsSynthesis).mockImplementation(async request => ({
      global_insights: { summary: `Síntese de ${request.analyzed_count} feedbacks`, recommendations: ['Ação consolidada'] },
    }));
  });

  it('2.050 feedbacks num escopo viram 103 lotes, e o total já prevê as rodadas da síntese', async () => {
    vi.mocked(repo.fetchAlreadyAnalyzedFeedbacks).mockResolvedValue(Array.from({ length: 2050 }, (_, i) => ({
      id: 'f-' + i, message: 'Feedback teste', rating: 3, created_at: '2026-01-01', scope_type: 'COMPANY',
      catalog_item: null, collection_point: null, dynamic_answers: [], dynamic_subanswers: [],
    })));
    const prepared = (await prepareInsightsJob('tenant-A', { scope_type: 'COMPANY' }))!;
    expect(prepared.batches).toHaveLength(103);
    // 103 lotes + dois blocos (52 e 51 parciais) + a síntese final dos dois.
    expect(countInsightsJobSteps(prepared)).toBe(106);
  });

  it('103 parciais: dois blocos parecidos e uma síntese final, nunca mais de 100 por chamada', async () => {
    const { report, requests } = await synthesizeReport(checkpointWithPartials(103));
    expect(requests.map(request => request.partial_insights.length)).toEqual([52, 51, 2]);
    expect(requests.map(request => request.analyzed_count)).toEqual([1040, 1020, 2060]);
    expect(requests[2].partial_insights.map(insight => insight.summary))
      .toEqual(['Síntese de 1040 feedbacks', 'Síntese de 1020 feedbacks']);
    expect(report).toEqual([expect.objectContaining({ analyzedCount: 2060,
      globalInsights: expect.objectContaining({ summary: 'Síntese de 2060 feedbacks' }) })]);
  });

  it('250 parciais: o número de chamadas bate com o previsto no início', async () => {
    const checkpoint = checkpointWithPartials(250);
    const expectedCalls = countRemainingSynthesisSteps(checkpoint);
    const { report, requests } = await synthesizeReport(checkpoint);
    expect(requests.map(request => request.partial_insights.length)).toEqual([84, 83, 83, 3]);
    expect(requests).toHaveLength(expectedCalls);
    expect(requests.every(request => request.partial_insights.length <= MAX_PARTIALS_PER_SYNTHESIS)).toBe(true);
    expect(report[0].analyzedCount).toBe(5000);
  });

  it('parciais longos: cada corpo fica abaixo do limite do IA Analyze, mesmo com menos de 100', async () => {
    const longSummary = (index: number) => `Resumo ${index}: ` + 'Atendimento ágil e preço acessível. '.repeat(60);
    const { report, requests } = await synthesizeReport(checkpointWithPartials(80, longSummary));
    expect(requests.length).toBeGreaterThan(1);
    for (const request of requests) {
      expect(Buffer.byteLength(JSON.stringify(request), 'utf8')).toBeLessThanOrEqual(MAX_SYNTHESIS_BODY_BYTES);
    }
    expect(report[0].analyzedCount).toBe(1600);
  });

  it('parcial que sobra sozinho entra na rodada seguinte sem chamada própria', async () => {
    // Cada parcial tem ~40 kB: só dois cabem num corpo.
    const hugeSummary = (index: number) => `Resumo ${index}: ` + 'x'.repeat(40_000);
    const { report, requests } = await synthesizeReport(checkpointWithPartials(3, hugeSummary));
    expect(requests.map(request => request.partial_insights.length)).toEqual([2, 2]);
    expect(requests[1].partial_insights.map(insight => insight.summary.slice(0, 10)))
      .toEqual(['Síntese de', 'Resumo 2: ']);
    expect(report[0].analyzedCount).toBe(60);
  });

  it('falha numa rodada intermediária não perde os blocos já sintetizados', async () => {
    const checkpoint = checkpointWithPartials(103);
    const afterFirstBlock = await runInsightsSynthesis(checkpoint);
    vi.mocked(runIaInsightsSynthesis).mockRejectedValueOnce(new Error('timeout'));
    await expect(runInsightsSynthesis(afterFirstBlock)).rejects.toThrow('timeout');
    const target = afterFirstBlock.synthesisTargets![0];
    expect(target.pendingPartials).toHaveLength(51);
    expect(target.nextRoundPartials).toEqual([expect.objectContaining({ analyzedCount: 1040 })]);
  });
});
