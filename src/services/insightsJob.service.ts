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
import type { IaInsightsSynthesisRequest } from '@feedback/lib-shared/interfaces/contracts/ia-analyze/insights-synthesis.contract';

export type PartialInsight = { insights: IaAnalyzeInsights; analyzedCount: number };

export type InsightsSynthesisTarget = {
  scopeType: IaAnalyzeContext['scope_type'];
  catalogItemId: string | null;
  catalogItemName: string | null;
  analyzedCount: number;
  /** Entradas da rodada atual que ainda não foram sintetizadas. */
  pendingPartials: PartialInsight[];
  /** Resultados da rodada atual: viram as entradas da próxima. */
  nextRoundPartials: PartialInsight[];
};

// Teto do IA Analyze por chamada (insightsSynthesisRequest.validation.ts): acima disso, 400.
export const MAX_PARTIALS_PER_SYNTHESIS = 100;
// O express.json() do IA Analyze recusa corpo acima de 100 kB com 413; a folga cobre a conta aproximada.
export const MAX_SYNTHESIS_BODY_BYTES = 90_000;

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

/** Agrupa os resultados map por relatório; cada lote vira um parcial da primeira rodada. */
export function buildInsightsSynthesisTargets(contexts: IaAnalyzeContext[]): InsightsSynthesisTarget[] {
  const targets = new Map<string, InsightsSynthesisTarget>();
  for (const context of contexts) {
    if (!context.globalInsights?.summary?.trim()) continue;
    const key = scopeKey(context.scope_type, context.catalog_item_id);
    const partial = { insights: context.globalInsights, analyzedCount: context.analyzedCount };
    const current = targets.get(key);
    if (current) {
      current.analyzedCount += context.analyzedCount;
      current.pendingPartials.push(partial);
    } else {
      targets.set(key, {
        scopeType: context.scope_type,
        catalogItemId: context.catalog_item_id,
        catalogItemName: context.catalog_item_name,
        analyzedCount: context.analyzedCount,
        pendingPartials: [partial],
        nextRoundPartials: [],
      });
    }
  }
  return [...targets.values()];
}

/**
 * Chamadas de síntese que faltam para um relatório. Cada rodada divide as entradas em blocos de
 * até 100 e gera um parcial por bloco; um parcial que sobra sozinho passa adiante sem chamada.
 * Conta só pelo teto de quantidade: se o tamanho do corpo pedir blocos menores, o total cresce
 * no caminho.
 */
function countSynthesisCalls(pending: number, nextRound = 0): number {
  if (nextRound === 0 && pending <= MAX_PARTIALS_PER_SYNTHESIS) return 1;
  const carried = pending === 1 ? 1 : 0;
  const blocks = carried ? 0 : Math.ceil(pending / MAX_PARTIALS_PER_SYNTHESIS);
  return blocks + countSynthesisCalls(nextRound + blocks + carried);
}

/** Total previsto desde o snapshot: N lotes map + as chamadas de síntese de cada relatório. */
export function countInsightsJobSteps(checkpoint: IaJobCheckpoint): number {
  const batchesPerReport = new Map<string, number>();
  for (const batch of checkpoint.batches) {
    const key = scopeKey(batch.scopeType, batch.catalogItemId);
    batchesPerReport.set(key, (batchesPerReport.get(key) ?? 0) + 1);
  }
  let synthesisCalls = 0;
  for (const partials of batchesPerReport.values()) synthesisCalls += countSynthesisCalls(partials);
  return checkpoint.batches.length + synthesisCalls;
}

/** Chamadas de síntese que ainda faltam, para o total do job acompanhar as rodadas. */
export function countRemainingSynthesisSteps(checkpoint: IaJobCheckpoint): number {
  let remaining = 0;
  for (const target of (checkpoint.synthesisTargets ?? []).slice(checkpoint.cursor)) {
    remaining += countSynthesisCalls(target.pendingPartials.length, target.nextRoundPartials.length);
  }
  return remaining;
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

function sumAnalyzedCount(partials: PartialInsight[]): number {
  return partials.reduce((sum, partial) => sum + partial.analyzedCount, 0);
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function buildSynthesisRequest(
  checkpoint: IaJobCheckpoint,
  target: InsightsSynthesisTarget,
  block: PartialInsight[],
): IaInsightsSynthesisRequest {
  return {
    enterprise_context: checkpoint.enterpriseContext,
    scope_type: target.scopeType,
    catalog_item_id: target.catalogItemId,
    catalog_item_name: target.catalogItemName,
    analyzed_count: sumAnalyzedCount(block),
    partial_insights: block.map(partial => partial.insights),
  };
}

/** Um parcial que sobrou sozinho no fim da rodada entra na próxima sem gastar chamada. */
function carryLonePartial(target: InsightsSynthesisTarget): InsightsSynthesisTarget {
  if (target.pendingPartials.length !== 1 || target.nextRoundPartials.length === 0) return target;
  return {
    ...target,
    pendingPartials: [...target.nextRoundPartials, ...target.pendingPartials],
    nextRoundPartials: [],
  };
}

/**
 * Tira do início da rodada o próximo bloco. A rodada é dividida em blocos de tamanho parecido,
 * para nenhum parcial da rodada seguinte resumir bem menos feedbacks que os outros, e o bloco
 * fecha antes de o corpo passar do limite do IA Analyze.
 */
function takeSynthesisBlock(checkpoint: IaJobCheckpoint, target: InsightsSynthesisTarget): PartialInsight[] {
  const pending = target.pendingPartials;
  const blockSize = Math.ceil(pending.length / Math.ceil(pending.length / MAX_PARTIALS_PER_SYNTHESIS));
  // Conta com o total do relatório, nunca menor que o de um bloco: a estimativa fica por cima.
  const emptyRequest = { ...buildSynthesisRequest(checkpoint, target, []), analyzed_count: target.analyzedCount };
  let bodyBytes = jsonBytes(emptyRequest);
  const block: PartialInsight[] = [];
  for (const partial of pending.slice(0, blockSize)) {
    const partialBytes = jsonBytes(partial.insights) + 1; // + a vírgula entre os itens
    // Com menos de dois parciais a rodada não encolhe. Um par grande demais segue assim mesmo,
    // e o IA Analyze recusa com 413: o job falha com erro em vez de repetir para sempre.
    if (block.length >= 2 && bodyBytes + partialBytes > MAX_SYNTHESIS_BODY_BYTES) break;
    block.push(partial);
    bodyBytes += partialBytes;
  }
  return block;
}

/** Guarda o resultado de uma chamada: o relatório final, ou um parcial da próxima rodada. */
function recordSynthesis(
  checkpoint: IaJobCheckpoint,
  target: InsightsSynthesisTarget,
  block: PartialInsight[],
  insights: IaAnalyzeInsights,
): IaJobCheckpoint {
  const pendingPartials = target.pendingPartials.slice(block.length);
  if (pendingPartials.length === 0 && target.nextRoundPartials.length === 0) {
    return {
      ...checkpoint,
      cursor: checkpoint.cursor + 1,
      synthesizedContexts: [...(checkpoint.synthesizedContexts ?? []), {
        scope_type: target.scopeType,
        catalog_item_id: target.catalogItemId,
        catalog_item_name: target.catalogItemName,
        analyzedCount: target.analyzedCount,
        globalInsights: insights,
      }],
    };
  }
  const nextRoundPartials = [...target.nextRoundPartials, { insights, analyzedCount: sumAnalyzedCount(block) }];
  const advanced = pendingPartials.length > 0
    ? { ...target, pendingPartials, nextRoundPartials }
    : { ...target, pendingPartials: nextRoundPartials, nextRoundPartials: [] };
  return {
    ...checkpoint,
    synthesisTargets: checkpoint.synthesisTargets?.map((item, index) => index === checkpoint.cursor ? advanced : item),
  };
}

/**
 * Executa exatamente uma chamada de síntese por passo do worker e devolve o checkpoint seguinte.
 * Até 100 parciais (e dentro do limite de corpo), é a chamada final do relatório; acima disso, a
 * síntese anda em rodadas: cada bloco vira um parcial, e a rodada seguinte sintetiza esses
 * parciais, até sobrar uma chamada só.
 */
export async function runInsightsSynthesis(
  checkpoint: IaJobCheckpoint,
  creds?: IaCreds,
): Promise<IaJobCheckpoint> {
  const current = checkpoint.synthesisTargets?.[checkpoint.cursor];
  if (!current) throw new IaAnalyzeServiceError('insights_not_generated', 502, 'insights_not_generated');
  const target = carryLonePartial(current);
  const block = takeSynthesisBlock(checkpoint, target);
  const result = await runIaInsightsSynthesis(buildSynthesisRequest(checkpoint, target, block), creds);
  if (!result.global_insights.summary?.trim()) {
    throw new IaAnalyzeServiceError('insights_not_generated', 502, 'insights_not_generated');
  }
  return recordSynthesis(checkpoint, target, block, result.global_insights);
}
