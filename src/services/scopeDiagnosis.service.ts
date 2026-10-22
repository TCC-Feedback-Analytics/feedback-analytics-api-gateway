import type {
  ScopeDiagnosis,
  ScopeDiagnosisAccepted,
  ScopeDiagnosisRemoteRequest,
} from '@feedback/lib-shared/interfaces/contracts/ia-analyze/scope-diagnosis.contract';
import type { IaAnalyzeScopeType } from '@feedback/lib-shared/interfaces/contracts/ia-analyze/scope.contract';
import type { IaCreds } from '../providers/iaAnalyze.provider.js';
import { runScopeDiagnosis } from '../providers/scopeDiagnosis.provider.js';
import { IaAnalyzeServiceError } from '../libs/iaAnalyze/errors.js';
import { buildEnterpriseContext } from '../libs/iaAnalyze/build.js';
import { MIN_FEEDBACKS_FOR_RELEVANT_ANALYSIS, hasRequiredEnterpriseInfoForAnalysis } from '../libs/iaAnalyze/rules.js';
import type { MetricsPeriod } from '../libs/period.js';
import {
  diagnosisDataHash,
  movementBucketFor,
  previousPeriodOf,
  selectCommentSamples,
  toDiagnosisCommentField,
  toDiagnosisMetrics,
  toDiagnosisPeriod,
  type ScopeMetricsSnapshot,
} from '../libs/scopeDiagnosis.js';
import { kickWorker } from '../libs/iaJob/kickWorker.js';
import { fetchEnterpriseContextForAnalysis } from '../repositories/iaAnalyze.repository.js';
import { fetchCatalogItemsByIds } from '../repositories/feedbackList.repository.js';
import { fetchScopedCommentCount, fetchScopedRatingAggregates } from '../repositories/feedbackStats.repository.js';
import { resolveScopeCollectionPointIds } from '../repositories/scope.repository.js';
import { enqueueIaJob } from '../repositories/iaJob.repository.js';
import {
  findScopeDiagnosisByHash,
  insertScopeDiagnosis,
  type ScopeDiagnosisKey,
  type ScopeDiagnosisRow,
} from '../repositories/scopeDiagnosis.repository.js';
import { resolveCompanyQuestionCreds } from './companyQuestionSuggestions.service.js';
import {
  computeScopedAnalysis,
  computeScopedCustomers,
  computeScopedHeatmap,
  computeScopedStats,
  computeScopedTimeline,
} from './scopeMetrics.service.js';
import { computeScopedQuestionMetrics } from './questionMetrics.service.js';

type ScopeTarget = {
  enterpriseId: string;
  scopeType: IaAnalyzeScopeType;
  catalogItemId: string | null;
};

/** O que o job guarda até chamar a IA (o pacote leva textos de comentários: some ao terminar). */
export type ScopeDiagnosisJobOptions = {
  phase: 'diagnosing';
  request: ScopeDiagnosisRemoteRequest;
  dataHash: string;
  feedbackCount: number;
};

/** As métricas de um período, as mesmas das telas. */
async function snapshotOf(params: {
  enterpriseId: string;
  collectionPointIds: string[] | null;
  period: MetricsPeriod;
  timeZone: string;
}): Promise<ScopeMetricsSnapshot> {
  const bucket = movementBucketFor(params.period);
  const [stats, analysis, questions, withComment, points, heatmap, customers] = await Promise.all([
    computeScopedStats(params),
    computeScopedAnalysis(params),
    computeScopedQuestionMetrics(params),
    fetchScopedCommentCount(params),
    computeScopedTimeline({ ...params, bucket }),
    computeScopedHeatmap(params),
    computeScopedCustomers(params),
  ]);
  return {
    stats, analysis, questions, withComment, heatmap, customers,
    movement: points ? { bucket, points } : null,
  };
}

/**
 * Monta o pacote do escopo no período e no anterior de mesmo tamanho. Falha com
 * 422 sem os dados de coleta da empresa ou com menos avaliações que o mínimo.
 */
export async function buildScopeDiagnosisPackage(params: ScopeTarget & {
  catalogItemName: string | null;
  collectionPointIds: string[] | null;
  period: MetricsPeriod;
  timeZone: string;
}): Promise<{ request: ScopeDiagnosisRemoteRequest; feedbackCount: number }> {
  const { collecting, enterpriseName } = await fetchEnterpriseContextForAnalysis({ enterpriseId: params.enterpriseId });
  if (!hasRequiredEnterpriseInfoForAnalysis(collecting)) {
    throw new IaAnalyzeServiceError('collecting_data_required_for_analysis', 422, 'collecting_data_required_for_analysis');
  }

  const base = { enterpriseId: params.enterpriseId, collectionPointIds: params.collectionPointIds, timeZone: params.timeZone };
  const current = await snapshotOf({ ...base, period: params.period });
  if (current.stats.totalFeedbacks < MIN_FEEDBACKS_FOR_RELEVANT_ANALYSIS) {
    throw new IaAnalyzeServiceError('insufficient_feedbacks_for_analysis', 422, 'insufficient_feedbacks_for_analysis');
  }

  const previousPeriod = previousPeriodOf(params.period);
  const previous = previousPeriod ? await snapshotOf({ ...base, period: previousPeriod }) : null;

  return {
    feedbackCount: current.stats.totalFeedbacks,
    request: {
      enterprise_context: buildEnterpriseContext({ collecting, enterpriseName }),
      scope: { scope_type: params.scopeType, catalog_item_id: params.catalogItemId, catalog_item_name: params.catalogItemName },
      period: toDiagnosisPeriod(params.period),
      previous_period: previousPeriod ? toDiagnosisPeriod(previousPeriod) : null,
      current: toDiagnosisMetrics(current),
      // Sem avaliações no período anterior, não há com o que comparar.
      previous: previous && previous.stats.totalFeedbacks > 0 ? toDiagnosisMetrics(previous) : null,
      comment_samples: selectCommentSamples(current.analysis),
      comment_field: toDiagnosisCommentField(current.stats),
    },
  };
}

/**
 * Pedido do gestor: confere item, IA e dados, devolve o diagnóstico guardado se
 * o recorte e os dados não mudaram (sem pagar IA) ou enfileira a geração.
 */
export async function requestScopeDiagnosis(params: ScopeTarget & {
  userId: string;
  period: MetricsPeriod;
  timeZone: string;
  force: boolean;
}): Promise<ScopeDiagnosisAccepted> {
  let catalogItemName: string | null = null;
  if (params.catalogItemId) {
    const [item] = await fetchCatalogItemsByIds(params.enterpriseId, [params.catalogItemId]);
    if (!item || item.kind !== params.scopeType) {
      throw new IaAnalyzeServiceError('catalog_item_not_found', 404, 'catalog_item_not_found');
    }
    catalogItemName = item.name;
  }

  // Sem chave e modelo da empresa, nem monta o pacote.
  await resolveCompanyQuestionCreds(params.enterpriseId);

  const scope = await resolveScopeCollectionPointIds({
    enterpriseId: params.enterpriseId,
    scopeType: params.scopeType,
    catalogItemId: params.catalogItemId,
  });
  if (scope.error) throw new IaAnalyzeServiceError('failed_to_fetch_stats', 500, 'failed_to_fetch_stats');

  const pack = await buildScopeDiagnosisPackage({ ...params, catalogItemName, collectionPointIds: scope.ids });
  const dataHash = diagnosisDataHash(pack.request);
  const key: ScopeDiagnosisKey = { enterpriseId: params.enterpriseId, scopeType: params.scopeType, catalogItemId: params.catalogItemId };

  if (!params.force) {
    const cachedId = await findScopeDiagnosisByHash(key, dataHash);
    if (cachedId) return { jobId: null, status: 'completed', deduped: false, cached: true, diagnosisId: cachedId };
  }

  const options: ScopeDiagnosisJobOptions = { phase: 'diagnosing', request: pack.request, dataHash, feedbackCount: pack.feedbackCount };
  const { jobId, status, deduped } = await enqueueIaJob({
    enterpriseId: params.enterpriseId,
    jobType: 'generate_scope_diagnosis',
    scopeType: params.scopeType,
    catalogItemId: params.catalogItemId,
    requestedBy: params.userId,
    options,
  });
  kickWorker();
  return { jobId, status, deduped, cached: false, diagnosisId: null };
}

export function readScopeDiagnosisJobOptions(options: Record<string, unknown>): ScopeDiagnosisJobOptions {
  const request = options.request as ScopeDiagnosisRemoteRequest | undefined;
  if (!request || typeof request !== 'object' || typeof options.dataHash !== 'string' || typeof options.feedbackCount !== 'number') {
    throw new IaAnalyzeServiceError('invalid_scope_diagnosis_job', 422, 'invalid_scope_diagnosis_job');
  }
  return { phase: 'diagnosing', request, dataHash: options.dataHash, feedbackCount: options.feedbackCount };
}

/** Passo do worker: chama a IA uma vez e guarda o resultado. Devolve o id do diagnóstico. */
export async function executeScopeDiagnosisJob(
  job: { enterpriseId: string; scopeType: string; catalogItemId: string | null },
  options: ScopeDiagnosisJobOptions,
  creds: IaCreds,
): Promise<string> {
  const result = await runScopeDiagnosis(options.request, creds);
  return insertScopeDiagnosis({
    enterpriseId: job.enterpriseId,
    scopeType: job.scopeType,
    catalogItemId: job.catalogItemId,
    periodStart: options.request.period.start,
    periodEnd: options.request.period.end,
    previousStart: options.request.previous_period?.start ?? null,
    previousEnd: options.request.previous_period?.end ?? null,
    feedbackCount: options.feedbackCount,
    dataHash: options.dataHash,
    model: creds.model ?? null,
    result,
  });
}

/**
 * Avaliações que chegaram no período do diagnóstico depois que ele foi gerado:
 * é o que diz à Web se ele ficou velho.
 */
async function countNewFeedbacksSince(enterpriseId: string, row: ScopeDiagnosisRow): Promise<number> {
  if (row.periodEnd && Date.parse(row.periodEnd) <= Date.parse(row.createdAt)) return 0;
  const scope = await resolveScopeCollectionPointIds({
    enterpriseId,
    scopeType: row.scopeType as IaAnalyzeScopeType,
    catalogItemId: row.catalogItemId,
  });
  if (scope.error) return 0;
  const since = row.periodStart && Date.parse(row.periodStart) > Date.parse(row.createdAt) ? row.periodStart : row.createdAt;
  const { totalFeedbacks } = await fetchScopedRatingAggregates({
    enterpriseId,
    collectionPointIds: scope.ids,
    period: { start: new Date(since).toISOString(), end: row.periodEnd },
  });
  return totalFeedbacks;
}

/** O Postgres devolve `2026-09-01 03:00:00+00`; a Web recebe ISO, como nas outras rotas de período. */
function iso(value: string | null): string | null {
  return value ? new Date(Date.parse(value)).toISOString() : null;
}

/** Diagnóstico guardado no formato da Web, com a contagem de novidades. */
export async function toScopeDiagnosis(enterpriseId: string, row: ScopeDiagnosisRow): Promise<ScopeDiagnosis> {
  return {
    id: row.id,
    scopeType: row.scopeType as IaAnalyzeScopeType,
    catalogItemId: row.catalogItemId,
    period: { start: iso(row.periodStart), end: iso(row.periodEnd) },
    previousPeriod: row.previousStart || row.previousEnd ? { start: iso(row.previousStart), end: iso(row.previousEnd) } : null,
    feedbackCount: row.feedbackCount,
    newFeedbacksSince: await countNewFeedbacksSince(enterpriseId, row),
    model: row.model,
    createdAt: iso(row.createdAt) ?? row.createdAt,
    result: row.result,
  };
}
