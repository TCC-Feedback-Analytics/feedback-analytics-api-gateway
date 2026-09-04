import { vi, describe, it, expect, beforeEach } from 'vitest';
import { IaAnalyzeServiceError } from '../libs/iaAnalyze/errors.js';
import { drainJobs } from '../libs/iaJob/drainJobs.js';
import { claimNextIaJob, saveClaimedIaJob, IaJobLeaseLostError, type ClaimedIaJob } from '../repositories/iaJob.repository.js';
import { fetchAlreadyAnalyzedFeedbackIds, upsertFeedbackInsightsReports } from '../repositories/iaAnalyze.repository.js';
import { prepareAnalyzeRawJob, runOneBatch } from '../services/iaAnalyze.service.js';
import { prepareInsightsJob, runInsightsBatch, runInsightsSynthesis, type IaJobCheckpoint } from '../services/insightsJob.service.js';
import { reserveIaBudget } from '../libs/iaJob/rateBudget.js';

vi.mock('../repositories/iaJob.repository.js', () => ({
  claimNextIaJob: vi.fn(), saveClaimedIaJob: vi.fn(), IaJobLeaseLostError: class extends Error {},
}));
vi.mock('../repositories/iaAnalyze.repository.js', () => ({
  fetchAlreadyAnalyzedFeedbackIds: vi.fn(), upsertFeedbackInsightsReports: vi.fn(),
}));
vi.mock('../services/iaAnalyze.service.js', () => ({
  prepareAnalyzeRawJob: vi.fn(), runOneBatch: vi.fn(), resolveIaCredsOrThrow: vi.fn(),
}));
vi.mock('../services/insightsJob.service.js', async importOriginal => ({
  ...await importOriginal<typeof import('../services/insightsJob.service.js')>(),
  prepareInsightsJob: vi.fn(), runInsightsBatch: vi.fn(), runInsightsSynthesis: vi.fn(),
}));
vi.mock('../libs/iaJob/rateBudget.js', () => ({ reserveIaBudget: vi.fn() }));

let saved: ClaimedIaJob & { status: string; errorCode?: string | null };
let persisted: Set<string>;
function snapshot(phase: IaJobCheckpoint['phase'], count = 42): IaJobCheckpoint {
  return { phase, enterpriseContext: {}, cursor: 0, contexts: [], startedAt: '2026-09-01T12:00:00Z',
    batches: Array.from({ length: Math.ceil(count / 20) }, (_, index) => ({
      scopeType: 'COMPANY', catalogItemId: null, catalogItemName: null,
      feedbacks: Array.from({ length: Math.min(20, count - index * 20) }, (_, n) => ({ id: 'f-' + (index * 20 + n) })),
    })),
  } as unknown as IaJobCheckpoint;
}
async function tick() {
  vi.mocked(claimNextIaJob).mockResolvedValueOnce(structuredClone(saved));
  return (await drainJobs({ maxBatches: 1 })).results[0];
}
beforeEach(() => {
  vi.resetAllMocks();
  persisted = new Set();
  saved = { id: 'job-1', enterpriseId: 'tenant-A', jobType: 'analyze_raw', scopeType: 'COMPANY',
    catalogItemId: null, options: {}, done: 0, total: 0, attempts: 1, status: 'running' };
  vi.mocked(saveClaimedIaJob).mockImplementation(async (_job, update) => {
    Object.assign(saved, structuredClone(update));
  });
  vi.mocked(prepareAnalyzeRawJob).mockImplementation(async () => ({
    ...snapshot('analyzing'), allowedFeedbackIds: new Set(),
  }));
  vi.mocked(prepareInsightsJob).mockImplementation(async () => snapshot('generating'));
  vi.mocked(fetchAlreadyAnalyzedFeedbackIds).mockImplementation(async ({ feedbackIds }) =>
    new Set(feedbackIds.filter(id => persisted.has(id))));
  vi.mocked(runOneBatch).mockImplementation(async ({ batch }) => {
    batch.feedbacks.forEach(f => persisted.add(f.id));
    return batch.feedbacks.length;
  });
  vi.mocked(runInsightsBatch).mockImplementation(async checkpoint => [{
    scope_type: 'COMPANY', catalog_item_id: null, catalog_item_name: null,
    analyzedCount: checkpoint.batches[checkpoint.cursor].feedbacks.length,
    globalInsights: { summary: 'Lote ' + checkpoint.cursor, recommendations: ['Melhorar atendimento'] },
  }]);
  vi.mocked(runInsightsSynthesis).mockImplementation(async checkpoint => {
    const target = checkpoint.synthesisTargets![checkpoint.cursor];
    return {
      scope_type: target.scopeType, catalog_item_id: target.catalogItemId,
      catalog_item_name: target.catalogItemName, analyzedCount: target.analyzedCount,
      globalInsights: { summary: 'Relatório final consolidado', recommendations: ['Melhorar atendimento'] },
    };
  });
  vi.mocked(upsertFeedbackInsightsReports).mockImplementation(async ({ contexts }) => contexts);
  vi.mocked(reserveIaBudget).mockResolvedValue({ ok: true });
});

describe('worker sempre assíncrono e retomável', () => {
  it('fila vazia não executa nada', async () => {
    vi.mocked(claimNextIaJob).mockResolvedValue(null);
    expect(await drainJobs()).toEqual({ processed: 0, results: [] });
  });
  it('snapshot de 102 pendentes avança 20 por tick e inclui os últimos dois', async () => {
    vi.mocked(prepareAnalyzeRawJob).mockResolvedValue({ ...snapshot('analyzing', 102), allowedFeedbackIds: new Set() });
    for (let n = 1; n <= 6; n += 1) {
      const result = await tick();
      expect(result.done).toBe(Math.min(102, n * 20));
      expect(result.status).toBe(n === 6 ? 'completed' : 'requeued');
    }
    expect(prepareAnalyzeRawJob).toHaveBeenCalledOnce();
    expect(persisted.size).toBe(102);
    expect(saved.options.checkpoint).toBeUndefined();
  });
  it('persistência incompleta não avança nem publica relatório', async () => {
    vi.mocked(runOneBatch).mockResolvedValue(1);
    expect(await tick()).toMatchObject({ status: 'failed', done: 0, errorCode: 'incomplete_ai_response' });
    expect(saved.done).toBe(0);
    expect(upsertFeedbackInsightsReports).not.toHaveBeenCalled();
  });
  it('retoma crash entre INSERT das análises e checkpoint sem chamar IA de novo', async () => {
    saved.options.checkpoint = snapshot('analyzing', 20);
    saved.total = 20;
    for (let i = 0; i < 20; i++) persisted.add('f-' + i);
    expect(await tick()).toMatchObject({ status: 'completed', done: 20, batchesRun: 0 });
    expect(runOneBatch).not.toHaveBeenCalled();
  });
  it('retomada concluída não captura novos feedbacks', async () => {
    saved.options.checkpoint = { ...snapshot('analyzing', 20), cursor: 1 };
    saved.done = saved.total = 20;
    expect(await tick()).toMatchObject({ status: 'completed', done: 20 });
    expect(prepareAnalyzeRawJob).not.toHaveBeenCalled();
  });
  it('orçamento insuficiente espera a janela sem falhar nem chamar IA', async () => {
    vi.mocked(reserveIaBudget).mockResolvedValue({ ok: false, reason: 'minute' });
    expect(await tick()).toMatchObject({ status: 'rescheduled', done: 0 });
    expect(saved.status).toBe('waiting_budget');
    expect(runOneBatch).not.toHaveBeenCalled();
  });
  it('validação de negócio falha no job, não na requisição de enfileiramento', async () => {
    vi.mocked(prepareAnalyzeRawJob).mockRejectedValue(new IaAnalyzeServiceError('invalid', 422, 'insufficient_feedbacks_for_analysis'));
    expect(await tick()).toMatchObject({ status: 'failed', errorCode: 'insufficient_feedbacks_for_analysis' });
  });
  it('nada pendente conclui sem consumir IA', async () => {
    vi.mocked(prepareAnalyzeRawJob).mockResolvedValue(null);
    expect(await tick()).toMatchObject({ status: 'completed', done: 0 });
    expect(runOneBatch).not.toHaveBeenCalled();
  });
  it('job unificado encadeia análise e relatório sem participação do navegador', async () => {
    saved.jobType = 'regenerate_insights';
    saved.options.analyzePending = true;
    vi.mocked(prepareAnalyzeRawJob).mockResolvedValue({ ...snapshot('analyzing', 20), allowedFeedbackIds: new Set() });
    await tick();
    expect(runInsightsBatch).not.toHaveBeenCalled();
    expect(saved.status).toBe('queued');
    for (let i = 0; i < 4; i++) await tick();
    expect(saved.status).toBe('completed');
    expect(upsertFeedbackInsightsReports).toHaveBeenCalledOnce();
    const report = vi.mocked(upsertFeedbackInsightsReports).mock.calls[0][0];
    expect(report.enterpriseId).toBe('tenant-A');
    expect(report.contexts[0].analyzedCount).toBe(42);
    expect(report.contexts[0].globalInsights?.summary).toBe('Relatório final consolidado');
    expect(runInsightsSynthesis).toHaveBeenCalledOnce();
  });
  it('erro na análise do job unificado nunca inicia síntese', async () => {
    saved.jobType = 'regenerate_insights'; saved.options.analyzePending = true;
    vi.mocked(runOneBatch).mockRejectedValue(new IaAnalyzeServiceError('invalid', 502, 'invalid_ai_response'));
    await tick();
    expect(saved.status).toBe('failed');
    expect(prepareInsightsJob).not.toHaveBeenCalled();
  });
  it('105 já analisados: pula análise e gera seis lotes sem perder os cinco finais', async () => {
    saved.jobType = 'regenerate_insights'; saved.options.analyzePending = true;
    vi.mocked(prepareAnalyzeRawJob).mockResolvedValue(null);
    vi.mocked(prepareInsightsJob).mockResolvedValue(snapshot('generating', 105));
    for (let i = 0; i < 7; i++) await tick();
    expect(runOneBatch).not.toHaveBeenCalled();
    expect(runInsightsBatch).toHaveBeenCalledTimes(6);
    expect(runInsightsSynthesis).toHaveBeenCalledOnce();
    expect(upsertFeedbackInsightsReports).toHaveBeenCalledWith(expect.objectContaining({
      contexts: [expect.objectContaining({ analyzedCount: 105 })],
    }));
  });
  it('cache hit conclui sem reservar cota nem chamar provedor', async () => {
    saved.jobType = 'regenerate_insights';
    vi.mocked(prepareInsightsJob).mockResolvedValue(null);
    expect(await tick()).toMatchObject({ status: 'completed', batchesRun: 0 });
    expect(reserveIaBudget).not.toHaveBeenCalled();
  });
  it('timeout no segundo lote retoma só esse lote, mantendo o primeiro', async () => {
    saved.jobType = 'regenerate_insights';
    await tick();
    vi.mocked(runInsightsBatch).mockRejectedValueOnce(new IaAnalyzeServiceError('timeout', 502, 'failed_remote_ia_analyze_request'));
    expect(await tick()).toMatchObject({ status: 'requeued', done: 1 });
    expect((saved.options.checkpoint as IaJobCheckpoint).cursor).toBe(1);
    await tick(); await tick(); await tick();
    expect(saved.status).toBe('completed');
    expect(runInsightsBatch).toHaveBeenCalledTimes(4);
    expect(prepareInsightsJob).toHaveBeenCalledOnce();
  });
  it('retentativas de timeout têm limite; mantém checkpoint para diagnóstico', async () => {
    saved.jobType = 'regenerate_insights';
    vi.mocked(runInsightsBatch).mockRejectedValue(new IaAnalyzeServiceError('timeout', 502, 'failed_remote_ia_analyze_request'));
    await tick(); await tick(); await tick();
    expect(saved.status).toBe('failed');
    expect(saved.done).toBe(0);
  });
  it('falha ao publicar não repete chamadas dos lotes já concluídos', async () => {
    saved.jobType = 'regenerate_insights';
    saved.options.checkpoint = { ...snapshot('synthesizing', 20), cursor: 1,
      synthesisTargets: [{ scopeType: 'COMPANY', catalogItemId: null, catalogItemName: null, analyzedCount: 20,
        partialInsights: [{ summary: 'Parcial', recommendations: [] }] }],
      synthesizedContexts: [{ scope_type: 'COMPANY', catalog_item_id: null, catalog_item_name: null,
        analyzedCount: 20, globalInsights: { summary: 'Pronto', recommendations: [] } }] };
    saved.total = saved.done = 2;
    vi.mocked(upsertFeedbackInsightsReports).mockResolvedValue([]);
    expect(await tick()).toMatchObject({ status: 'failed', errorCode: 'insights_not_generated' });
    expect(runInsightsBatch).not.toHaveBeenCalled();
  });
  it('timeout no reduce retoma somente a síntese, sem repetir os lotes map', async () => {
    saved.jobType = 'regenerate_insights';
    saved.options.checkpoint = { ...snapshot('synthesizing', 105), cursor: 0,
      contexts: [{ scope_type: 'COMPANY', catalog_item_id: null, catalog_item_name: null,
        analyzedCount: 105, globalInsights: { summary: 'Parcial', recommendations: [] } }],
      synthesisTargets: [{ scopeType: 'COMPANY', catalogItemId: null, catalogItemName: null,
        analyzedCount: 105, partialInsights: [{ summary: 'Parcial', recommendations: [] }] }],
      synthesizedContexts: [] };
    saved.total = 7; saved.done = 6;
    vi.mocked(runInsightsSynthesis).mockRejectedValueOnce(
      new IaAnalyzeServiceError('timeout', 502, 'failed_remote_ia_analyze_request'),
    );
    expect(await tick()).toMatchObject({ status: 'requeued', done: 6 });
    expect(await tick()).toMatchObject({ status: 'completed', done: 7 });
    expect(runInsightsBatch).not.toHaveBeenCalled();
    expect(runInsightsSynthesis).toHaveBeenCalledTimes(2);
    expect(upsertFeedbackInsightsReports).toHaveBeenCalledOnce();
  });
  it('worker que perdeu posse não conclui nem falha o job do novo worker', async () => {
    vi.mocked(saveClaimedIaJob).mockRejectedValue(new IaJobLeaseLostError('lost'));
    expect(await tick()).toMatchObject({ status: 'requeued', errorCode: 'ia_job_lease_lost' });
    expect(runOneBatch).not.toHaveBeenCalled();
    expect(saveClaimedIaJob).toHaveBeenCalledOnce();
  });
  it('erros também contam no limite do tick', async () => {
    vi.mocked(claimNextIaJob).mockImplementation(async () => structuredClone(saved));
    vi.mocked(prepareAnalyzeRawJob).mockRejectedValue(new Error('db unavailable'));
    expect((await drainJobs({ maxBatches: 2 })).processed).toBe(2);
    expect(claimNextIaJob).toHaveBeenCalledTimes(2);
  });
});
