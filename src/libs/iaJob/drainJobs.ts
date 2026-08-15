/**
 * Núcleo do worker (etapa 03): drena jobs da fila `ia_analysis_job`.
 *
 * Desenho "drain por cron": cada tick (invocação serverless curta, chamada por um
 * cron externo) processa até `IA_WORKER_BATCHES_PER_TICK` lotes no total e volta.
 * Jobs que não cabem no orçamento do tick são re-enfileirados e continuam no
 * próximo — de onde pararam (a persistência é por lote e o preparo re-deriva só
 * os feedbacks ainda não analisados). O MESMO `drainJobs()` pode virar um loop
 * always-on num host externo no futuro (etapa 08), sem reescrita.
 */
import { IaAnalyzeServiceError } from '../iaAnalyze/errors.js';
import {
  claimNextIaJob,
  completeIaJob,
  failIaJob,
  requeueIaJob,
  rescheduleForBudget,
  setIaJobTotal,
  updateIaJobDone,
  type ClaimedIaJob,
} from '../../repositories/iaJob.repository.js';
import {
  prepareAnalyzeRawJob,
  regenerateFeedbackInsights,
  runOneBatch,
} from '../../services/iaAnalyze.service.js';
import type {
  IaAnalyzeRawRunRequest,
  IaAnalyzeRegenerateInsightsRequest,
} from '@feedback/lib-shared/interfaces/contracts/ia-analyze/run.contract';
import type { IaAnalyzeScopeType } from '@feedback/lib-shared/interfaces/contracts/ia-analyze/scope.contract';
import { readBatchesPerTick } from './config.js';
import { reserveIaBudget } from './rateBudget.js';

export type DrainJobResult = {
  jobId: string;
  jobType: string;
  status: 'completed' | 'failed' | 'requeued' | 'rescheduled';
  done: number;
  total: number;
  errorCode?: string;
  batchesRun: number;
};

export type DrainResult = { processed: number; results: DrainJobResult[] };

/**
 * Processa jobs até esgotar o orçamento de lotes do tick ou a fila. Cada job é
 * isolado: uma falha marca aquele job como `failed` e NÃO derruba os demais.
 */
export async function drainJobs(params?: { maxBatches?: number }): Promise<DrainResult> {
  let remainingBatches = params?.maxBatches ?? readBatchesPerTick();
  const results: DrainJobResult[] = [];

  while (remainingBatches > 0) {
    const job = await claimNextIaJob();
    if (!job) break;

    const result = await processJob(job, remainingBatches);
    results.push(result);
    remainingBatches -= result.batchesRun;

    // Tick esgotado (requeued) OU orçamento de IA estourado (rescheduled) → para de puxar.
    if (result.status === 'requeued' || result.status === 'rescheduled') break;
  }

  return { processed: results.length, results };
}

async function processJob(job: ClaimedIaJob, batchBudget: number): Promise<DrainJobResult> {
  try {
    if (job.jobType === 'regenerate_insights') {
      return await processRegenerateJob(job);
    }
    return await processAnalyzeRawJob(job, batchBudget);
  } catch (error) {
    const errorCode = error instanceof IaAnalyzeServiceError ? error.code : 'unexpected_error';
    await failIaJob(job.id, errorCode);
    return {
      jobId: job.id,
      jobType: job.jobType,
      status: 'failed',
      done: job.done,
      total: job.total,
      errorCode,
      batchesRun: 0,
    };
  }
}

async function processAnalyzeRawJob(job: ClaimedIaJob, batchBudget: number): Promise<DrainJobResult> {
  const options: IaAnalyzeRawRunRequest = {
    limit: typeof job.options.limit === 'number' ? job.options.limit : undefined,
    scope_type: job.scopeType as IaAnalyzeScopeType,
    catalog_item_id: job.catalogItemId ?? undefined,
  };

  const prepared = await prepareAnalyzeRawJob({ enterpriseId: job.enterpriseId, options });

  // Nada NOVO a analisar: 1ª vez sem feedbacks OU retomada que já concluiu tudo.
  if (!prepared) {
    await completeIaJob(job.id, { total: job.total, done: job.total });
    return {
      jobId: job.id,
      jobType: job.jobType,
      status: 'completed',
      done: job.total,
      total: job.total,
      batchesRun: 0,
    };
  }

  // `total` (em feedbacks) é fixado só na 1ª vez; nas retomadas preserva o original.
  let total = job.total;
  if (total === 0) {
    total = prepared.batches.reduce((sum, batch) => sum + batch.feedbacks.length, 0);
    await setIaJobTotal(job.id, total);
  }

  let done = job.done;
  let batchesRun = 0;

  for (const batch of prepared.batches) {
    if (batchesRun >= batchBudget) {
      // Orçamento do tick esgotado — devolve à fila para continuar no próximo tick.
      await requeueIaJob(job.id);
      return { jobId: job.id, jobType: job.jobType, status: 'requeued', done, total, batchesRun };
    }

    const budget = await reserveIaBudget();
    if (!budget.ok) {
      // Sem orçamento de IA — espera a próxima janela (back-pressure).
      await rescheduleForBudget(job.id, budget.reason);
      return { jobId: job.id, jobType: job.jobType, status: 'rescheduled', done, total, batchesRun };
    }

    await runOneBatch({
      enterpriseContext: prepared.enterpriseContext,
      batch,
      allowedFeedbackIds: prepared.allowedFeedbackIds,
    });

    done += batch.feedbacks.length;
    batchesRun += 1;
    await updateIaJobDone(job.id, done);
  }

  await completeIaJob(job.id, { total, done });
  return { jobId: job.id, jobType: job.jobType, status: 'completed', done, total, batchesRun };
}

/**
 * "Gerar insights": operação única (tem cache de leitura próprio). Progresso
 * grosso (total=1). Consome 1 do orçamento do tick.
 */
async function processRegenerateJob(job: ClaimedIaJob): Promise<DrainJobResult> {
  const options: IaAnalyzeRegenerateInsightsRequest = {
    scope_type: job.scopeType as IaAnalyzeScopeType,
    catalog_item_id: job.catalogItemId ?? undefined,
    force: job.options.force === true,
  };

  const budget = await reserveIaBudget();
  if (!budget.ok) {
    await rescheduleForBudget(job.id, budget.reason);
    return { jobId: job.id, jobType: job.jobType, status: 'rescheduled', done: job.done, total: job.total || 1, batchesRun: 0 };
  }

  if (job.total === 0) await setIaJobTotal(job.id, 1);
  await regenerateFeedbackInsights({ enterpriseId: job.enterpriseId, options });
  await completeIaJob(job.id, { total: 1, done: 1 });

  return { jobId: job.id, jobType: job.jobType, status: 'completed', done: 1, total: 1, batchesRun: 1 };
}
