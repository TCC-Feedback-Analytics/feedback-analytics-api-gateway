import type { IaAnalyzeContext, IaAnalyzeInsights } from '@feedback/lib-shared/interfaces/contracts/ia-analyze/analysis.contract';
import type { IaAnalyzeRegenerateInsightsRequest } from '@feedback/lib-shared/interfaces/contracts/ia-analyze/run.contract';
import { buildAnalysisBatches, buildEnterpriseContext } from '../libs/iaAnalyze/build.js';
import { IaAnalyzeServiceError } from '../libs/iaAnalyze/errors.js';
import { MIN_FEEDBACKS_FOR_RELEVANT_ANALYSIS, hasRequiredEnterpriseInfoForAnalysis } from '../libs/iaAnalyze/rules.js';
import { scopeKey } from '../libs/iaAnalyze/insightsCache.js';
import { assertCompleteAnalyses } from '../libs/iaAnalyze/validateCompletion.js';
import { fetchAlreadyAnalyzedFeedbacks, fetchEnterpriseContextForAnalysis,
  fetchFeedbackInsightsReports, latestAnalysisForFeedbacks } from '../repositories/iaAnalyze.repository.js';
import { runIaAnalyzeAnalysis, runIaInsightsSynthesis, type IaCreds } from '../providers/iaAnalyze.provider.js';

export type InsightsSynthesisTarget = {
  scopeType: IaAnalyzeContext['scope_type'];
  catalogItemId: string | null;
  catalogItemName: string | null;
  analyzedCount: number;
  partialInsights: IaAnalyzeInsights[];
};

export type IaJobCheckpoint = {
  phase: 'analyzing' | 'generating' | 'synthesizing';
  enterpriseContext: ReturnType<typeof buildEnterpriseContext>;
  batches: ReturnType<typeof buildAnalysisBatches>;
  cursor: number;
  contexts: IaAnalyzeContext[];
  synthesisTargets?: InsightsSynthesisTarget[];
  synthesizedContexts?: IaAnalyzeContext[];
  startedAt: string;
};

/** Snapshot durável: cada tick trabalha no mesmo conjunto, inclusive acima de 100. */
export async function prepareInsightsJob(enterpriseId: string, options: IaAnalyzeRegenerateInsightsRequest): Promise<IaJobCheckpoint | null> {
  const startedAt = new Date().toISOString();
  const { collecting, enterpriseName } = await fetchEnterpriseContextForAnalysis({ enterpriseId });
  if (!hasRequiredEnterpriseInfoForAnalysis(collecting)) {
    throw new IaAnalyzeServiceError('collecting_data_required_for_analysis', 422, 'collecting_data_required_for_analysis');
  }
  const feedbacks = await fetchAlreadyAnalyzedFeedbacks({ enterpriseId, scopeType: options.scope_type,
    catalogItemId: options.catalog_item_id ?? null, all: true });
  if (feedbacks.length < MIN_FEEDBACKS_FOR_RELEVANT_ANALYSIS) {
    throw new IaAnalyzeServiceError('insufficient_feedbacks_for_analysis', 422, 'insufficient_feedbacks_for_analysis');
  }
  const batches = buildAnalysisBatches(feedbacks, options);
  if (!batches.length) throw new IaAnalyzeServiceError('insights_not_generated', 422, 'insights_not_generated');
  if (!options.force) {
    const reports = await fetchFeedbackInsightsReports({ enterpriseId, scopeType: options.scope_type, catalogItemId: options.catalog_item_id ?? null });
    const latest = await latestAnalysisForFeedbacks(enterpriseId, feedbacks.map(f => f.id));
    if (latest && batches.every(batch => reports.some(report =>
      report.scope_type === batch.scopeType && report.catalog_item_id === batch.catalogItemId &&
      Boolean(report.summary?.trim()) && Date.parse(report.updated_at ?? '') >= Date.parse(latest)))) {
      return null;
    }
  }
  return { phase: 'generating', enterpriseContext: buildEnterpriseContext({ collecting, enterpriseName }),
    batches, cursor: 0, contexts: [], startedAt };
}

/** Uma única chamada por passo; nenhuma análise individual é sobrescrita. */
export async function runInsightsBatch(checkpoint: IaJobCheckpoint, creds?: IaCreds): Promise<IaAnalyzeContext[]> {
  const batch = checkpoint.batches[checkpoint.cursor];
  const result = await runIaAnalyzeAnalysis({ enterprise_context: checkpoint.enterpriseContext, batches: [{
    scope_type: batch.scopeType, catalog_item_id: batch.catalogItemId,
    catalog_item_name: batch.catalogItemName, feedbacks: batch.feedbacks,
  }] }, creds);
  assertCompleteAnalyses(result.analyses, new Set(batch.feedbacks.map(f => f.id)));
  const context = result.contexts.find(c => c.scope_type === batch.scopeType && c.catalog_item_id === batch.catalogItemId);
  if (!context?.globalInsights?.summary?.trim()) {
    throw new IaAnalyzeServiceError('insights_not_generated', 502, 'insights_not_generated');
  }
  return [{ ...context, analyzedCount: batch.feedbacks.length }];
}

/** Agrupa os resultados map por relatório, preservando cada insight parcial para o reduce. */
export function buildInsightsSynthesisTargets(contexts: IaAnalyzeContext[]): InsightsSynthesisTarget[] {
  const targets = new Map<string, InsightsSynthesisTarget>();
  for (const context of contexts) {
    if (!context.globalInsights?.summary?.trim()) continue;
    const key = scopeKey(context.scope_type, context.catalog_item_id);
    const current = targets.get(key);
    if (current) {
      current.analyzedCount += context.analyzedCount;
      current.partialInsights.push(context.globalInsights);
    } else {
      targets.set(key, {
        scopeType: context.scope_type,
        catalogItemId: context.catalog_item_id,
        catalogItemName: context.catalog_item_name,
        analyzedCount: context.analyzedCount,
        partialInsights: [context.globalInsights],
      });
    }
  }
  return [...targets.values()];
}

/** Total conhecido desde o snapshot: N lotes map + um reduce por relatório. */
export function countInsightsJobSteps(checkpoint: IaJobCheckpoint): number {
  const reportKeys = new Set(checkpoint.batches.map(batch => scopeKey(batch.scopeType, batch.catalogItemId)));
  return checkpoint.batches.length + reportKeys.size;
}

export function beginInsightsSynthesis(checkpoint: IaJobCheckpoint): IaJobCheckpoint {
  const synthesisTargets = buildInsightsSynthesisTargets(checkpoint.contexts);
  if (synthesisTargets.length === 0) {
    throw new IaAnalyzeServiceError('insights_not_generated', 502, 'insights_not_generated');
  }
  return {
    ...checkpoint,
    phase: 'synthesizing',
    cursor: 0,
    synthesisTargets,
    synthesizedContexts: [],
  };
}

/** Executa exatamente um reduce por passo do worker. */
export async function runInsightsSynthesis(
  checkpoint: IaJobCheckpoint,
  creds?: IaCreds,
): Promise<IaAnalyzeContext> {
  const target = checkpoint.synthesisTargets?.[checkpoint.cursor];
  if (!target) throw new IaAnalyzeServiceError('insights_not_generated', 502, 'insights_not_generated');
  const result = await runIaInsightsSynthesis({
    enterprise_context: checkpoint.enterpriseContext,
    scope_type: target.scopeType,
    catalog_item_id: target.catalogItemId,
    catalog_item_name: target.catalogItemName,
    analyzed_count: target.analyzedCount,
    partial_insights: target.partialInsights,
  }, creds);
  if (!result.global_insights.summary?.trim()) {
    throw new IaAnalyzeServiceError('insights_not_generated', 502, 'insights_not_generated');
  }
  return {
    scope_type: target.scopeType,
    catalog_item_id: target.catalogItemId,
    catalog_item_name: target.catalogItemName,
    analyzedCount: target.analyzedCount,
    globalInsights: result.global_insights,
  };
}
