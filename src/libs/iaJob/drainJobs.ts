import { IaAnalyzeServiceError } from '../iaAnalyze/errors.js';
import { claimNextIaJob, saveClaimedIaJob, IaJobLeaseLostError, type ClaimedIaJob } from '../../repositories/iaJob.repository.js';
import { fetchAlreadyAnalyzedFeedbackIds, upsertFeedbackInsightsReports } from '../../repositories/iaAnalyze.repository.js';
import { prepareAnalyzeRawJob, resolveIaCredsOrThrow, runOneBatch } from '../../services/iaAnalyze.service.js';
import {
  beginInsightsSynthesis,
  countInsightsJobSteps,
  prepareInsightsJob,
  runInsightsBatch,
  runInsightsSynthesis,
  type IaJobCheckpoint,
} from '../../services/insightsJob.service.js';
import type { IaAnalyzeScopeType } from '@feedback/lib-shared/interfaces/contracts/ia-analyze/scope.contract';
import { readBatchesPerTick } from './config.js';
import { reserveIaBudget } from './rateBudget.js';

export type DrainJobResult = {
  jobId: string; jobType: string;
  status: 'completed' | 'failed' | 'requeued' | 'rescheduled';
  done: number; total: number; errorCode?: string; batchesRun: number;
};
export type DrainResult = { processed: number; results: DrainJobResult[] };
const RETRYABLE = new Set(['failed_remote_ia_analyze_request', 'ia_provider_unavailable', 'ia_provider_rate_limited', 'ia_provider_error']);

/** A requisição do usuário nunca executa isto. Cada claim tem lease e checkpoint. */
export async function drainJobs(params?: { maxBatches?: number }): Promise<DrainResult> {
  const max = Math.max(1, Math.floor(params?.maxBatches ?? readBatchesPerTick()));
  const results: DrainJobResult[] = [];
  // Inclusive falhas/cache/vazio consomem um slot: o tick nunca drena sem limite.
  for (let i = 0; i < max; i += 1) {
    const job = await claimNextIaJob();
    if (!job) break;
    results.push(await processJob(job));
  }
  return { processed: results.length, results };
}

async function processJob(job: ClaimedIaJob): Promise<DrainJobResult> {
  let batchesRun = 0;
  let leaseError: unknown;
  const heartbeat = setInterval(() => {
    void saveClaimedIaJob(job, {}).catch(error => { leaseError = error; });
  }, 30_000);
  const save = async (update: Parameters<typeof saveClaimedIaJob>[1]) => {
    if (leaseError) throw leaseError;
    await saveClaimedIaJob(job, update);
  };
  const result = (status: DrainJobResult['status'], errorCode?: string): DrainJobResult => ({
    jobId: job.id, jobType: job.jobType, status, total: job.total, done: job.done, batchesRun, errorCode,
  });
  const options = { scope_type: job.scopeType as IaAnalyzeScopeType, catalog_item_id: job.catalogItemId ?? undefined,
    limit: typeof job.options.limit === 'number' ? job.options.limit : undefined, force: job.options.force === true };
  // Não persiste mutações de um passo cuja gravação de checkpoint tenha falhado.
  let confirmedOptions = structuredClone(job.options);
  try {
    let checkpoint = job.options.checkpoint as IaJobCheckpoint | undefined;
    if (!checkpoint) {
      if (job.jobType === 'analyze_raw' || job.options.analyzePending === true) {
        const prepared = await prepareAnalyzeRawJob({ enterpriseId: job.enterpriseId, options });
        checkpoint = { phase: 'analyzing', enterpriseContext: prepared?.enterpriseContext ?? {},
          batches: prepared?.batches ?? [], cursor: 0, contexts: [], startedAt: new Date().toISOString() } as IaJobCheckpoint;
        job.total = checkpoint.batches.reduce((sum, batch) => sum + batch.feedbacks.length, 0);
        job.done = 0;
      } else {
        checkpoint = (await prepareInsightsJob(job.enterpriseId, options)) ?? undefined;
        job.total = checkpoint ? countInsightsJobSteps(checkpoint) : 0;
        job.done = 0;
      }
      job.options = { ...job.options, checkpoint };
      await save({ options: job.options, total: job.total, done: job.done });
      confirmedOptions = structuredClone(job.options);
    }

    // A sequência pertence à fila, não à aba/modal. Persiste a troca de fase.
    if (checkpoint?.phase === 'analyzing' && checkpoint.cursor >= checkpoint.batches.length && job.jobType === 'regenerate_insights') {
      checkpoint = (await prepareInsightsJob(job.enterpriseId, options)) ?? undefined;
      job.options = { ...job.options, checkpoint };
      job.total = checkpoint ? countInsightsJobSteps(checkpoint) : 0;
      job.done = 0;
      await save({ options: job.options, total: job.total, done: job.done });
      confirmedOptions = structuredClone(job.options);
    }

    if (checkpoint && checkpoint.phase !== 'synthesizing' && checkpoint.cursor < checkpoint.batches.length) {
      const batch = checkpoint.batches[checkpoint.cursor];
      // Recupera inclusive um crash após gravar análises e antes do checkpoint.
      const existing = checkpoint.phase === 'analyzing'
        ? await fetchAlreadyAnalyzedFeedbackIds({ feedbackIds: batch.feedbacks.map(f => f.id) }) : new Set<string>();
      const pending = batch.feedbacks.filter(f => !existing.has(f.id));
      if (pending.length) {
        const budget = await reserveIaBudget(job.enterpriseId);
        if (!budget.ok) {
          const now = Date.now();
          const windowMs = budget.reason === 'day' ? 86_400_000 : 60_000;
          await save({ status: 'waiting_budget', delaySeconds: Math.ceil((windowMs - now % windowMs) / 1000) });
          return result('rescheduled');
        }
        const creds = await resolveIaCredsOrThrow(job.enterpriseId);
        batchesRun = 1;
        if (checkpoint.phase === 'analyzing') {
          await runOneBatch({ enterpriseContext: checkpoint.enterpriseContext, batch: { ...batch, feedbacks: pending },
            allowedFeedbackIds: new Set(pending.map(f => f.id)), creds });
          const persisted = await fetchAlreadyAnalyzedFeedbackIds({ feedbackIds: batch.feedbacks.map(f => f.id) });
          if (batch.feedbacks.some(f => !persisted.has(f.id))) {
            throw new IaAnalyzeServiceError('incomplete_ai_response', 502, 'incomplete_ai_response');
          }
        } else {
          checkpoint.contexts.push(...await runInsightsBatch(checkpoint, creds));
        }
      }
      checkpoint.cursor += 1;
      job.done += checkpoint.phase === 'analyzing' ? batch.feedbacks.length : 1;
      job.options = { ...job.options, checkpoint, failures: 0 };
      await save({ options: job.options, done: job.done });
      confirmedOptions = structuredClone(job.options);
    }

    if (checkpoint?.phase === 'analyzing' && (checkpoint.cursor < checkpoint.batches.length ||
      job.jobType === 'regenerate_insights')) {
      await save({ status: 'queued', delaySeconds: 0, errorCode: null });
      return result('requeued');
    }

    if (checkpoint?.phase === 'generating') {
      if (checkpoint.cursor < checkpoint.batches.length) {
        await save({ status: 'queued', delaySeconds: 0, errorCode: null });
        return result('requeued');
      }
      checkpoint = beginInsightsSynthesis(checkpoint);
      job.options = { ...job.options, checkpoint };
      job.total = countInsightsJobSteps(checkpoint);
      await save({ options: job.options, total: job.total, done: job.done, status: 'queued', delaySeconds: 0, errorCode: null });
      confirmedOptions = structuredClone(job.options);
      return result('requeued');
    }

    if (checkpoint?.phase === 'synthesizing' && checkpoint.cursor < (checkpoint.synthesisTargets?.length ?? 0)) {
      const budget = await reserveIaBudget(job.enterpriseId);
      if (!budget.ok) {
        const now = Date.now();
        const windowMs = budget.reason === 'day' ? 86_400_000 : 60_000;
        await save({ status: 'waiting_budget', delaySeconds: Math.ceil((windowMs - now % windowMs) / 1000) });
        return result('rescheduled');
      }
      const creds = await resolveIaCredsOrThrow(job.enterpriseId);
      batchesRun = 1;
      checkpoint.synthesizedContexts ??= [];
      checkpoint.synthesizedContexts.push(await runInsightsSynthesis(checkpoint, creds));
      checkpoint.cursor += 1;
      job.done += 1;
      job.options = { ...job.options, checkpoint, failures: 0 };
      await save({ options: job.options, done: job.done });
      confirmedOptions = structuredClone(job.options);
    }

    if (checkpoint?.phase === 'synthesizing') {
      if (checkpoint.cursor < (checkpoint.synthesisTargets?.length ?? 0)) {
        await save({ status: 'queued', delaySeconds: 0, errorCode: null });
        return result('requeued');
      }
      await save({}); // Confirma posse antes de publicar, inclusive numa retomada.
      const contexts = checkpoint.synthesizedContexts ?? [];
      const persisted = await upsertFeedbackInsightsReports({ enterpriseId: job.enterpriseId, contexts, asOf: checkpoint.startedAt });
      if (!contexts.length || persisted.length !== contexts.length) {
        throw new IaAnalyzeServiceError('insights_not_generated', 502, 'insights_not_generated');
      }
    }
    // Remove textos de jobs terminados, conservando a fase para o polling final.
    const finishedOptions = { ...job.options };
    delete finishedOptions.checkpoint;
    await save({ status: 'completed', options: { ...finishedOptions, phase: checkpoint?.phase ?? 'generating' }, errorCode: null });
    return result('completed');
  } catch (error) {
    if (error instanceof IaJobLeaseLostError || leaseError) return result('requeued', 'ia_job_lease_lost');
    const code = error instanceof IaAnalyzeServiceError ? error.code : 'unexpected_error';
    const failures = Number(confirmedOptions.failures ?? 0) + 1;
    const retry = RETRYABLE.has(code) && failures < 3;
    await saveClaimedIaJob(job, { status: retry ? 'queued' : 'failed', errorCode: code,
      delaySeconds: Math.min(60, 5 * 2 ** failures),
      options: { ...confirmedOptions, failures },
    });
    return result(retry ? 'requeued' : 'failed', code);
  } finally {
    clearInterval(heartbeat);
  }
}
