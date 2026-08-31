import { runIaAnalyzeAnalysis, type IaCreds } from '../providers/iaAnalyze.provider.js';
import { resolveIaCredsForEnterprise, requireUserIaKey } from '../libs/iaConfig/resolveIaCreds.js';
import { IaAnalyzeServiceError } from '../libs/iaAnalyze/errors.js';
import {
  fetchAlreadyAnalyzedFeedbackIds,
  fetchAlreadyAnalyzedFeedbacks,
  fetchEnterpriseContextForAnalysis,
  fetchFeedbackInsightsReports,
  fetchFeedbacksForAnalysis,
  insertFeedbackAnalysisRows,
  upsertFeedbackInsightsReports,
} from '../repositories/iaAnalyze.repository.js';
import {
  countAnalyzedByScope,
  hasFeedbackNewerThanReports,
  reportRowToContext,
  scopeKey,
} from '../libs/iaAnalyze/insightsCache.js';
import type { IaAnalyzeRemoteRunRequest } from '@feedback/lib-shared/interfaces/contracts/ia-analyze/remote.contract';
import type {
  IaAnalyzeRawRunRequest,
  IaAnalyzeRawRunResponse,
  IaAnalyzeRegenerateInsightsRequest,
  IaAnalyzeRegenerateInsightsResponse,
} from '@feedback/lib-shared/interfaces/contracts/ia-analyze/run.contract';
import type { IaAnalyzeSentiment } from '@feedback/lib-shared/interfaces/contracts/ia-analyze/scope.contract';
import { buildEnterpriseContext, buildAnalysisBatches } from '../libs/iaAnalyze/build.js';
import { hasRequiredEnterpriseInfoForAnalysis, MIN_FEEDBACKS_FOR_RELEVANT_ANALYSIS } from '../libs/iaAnalyze/rules.js';
import { applyExecutionFilter } from '../libs/iaAnalyze/filter.js';

/**
 * Resolve as creds OpenRouter da empresa (BYO-key). Sem config, lança
 * `ia_config_required` por padrão. O fallback global legado só é permitido
 * quando `REQUIRE_USER_IA_KEY=false` estiver definido explicitamente.
 */
export async function resolveIaCredsOrThrow(enterpriseId: string): Promise<IaCreds | undefined> {
  const creds = await resolveIaCredsForEnterprise(enterpriseId);
  if (!creds && requireUserIaKey()) {
    throw new IaAnalyzeServiceError('ia_config_required', 400, 'ia_config_required');
  }
  return creds ?? undefined;
}

export type PreparedAnalyzeRawJob = {
  enterpriseContext: ReturnType<typeof buildEnterpriseContext>;
  batches: ReturnType<typeof buildAnalysisBatches>;
  allowedFeedbackIds: Set<string>;
};

/**
 * Fase de PREPARO da análise de feedbacks brutos, compartilhada pelo caminho
 * síncrono e pelo worker assíncrono (etapa 03): valida a empresa, busca os
 * feedbacks do escopo, aplica filtros, remove já-analisados e fatia em lotes.
 * NÃO chama o LLM nem persiste.
 *
 * - Retorna `null` quando não há nada NOVO para analisar (escopo vazio ou tudo
 *   já analisado) — o chamador trata como "0 analisados".
 * - Lança `IaAnalyzeServiceError` (422) nas validações de negócio (sem dados de
 *   coleta / feedbacks insuficientes) — o worker mapeia isso para o job falho.
 */
export async function prepareAnalyzeRawJob(params: {
  enterpriseId: string;
  options?: IaAnalyzeRawRunRequest;
}): Promise<PreparedAnalyzeRawJob | null> {
  const { enterpriseId, options } = params;

  const { collecting, enterpriseName } = await fetchEnterpriseContextForAnalysis({ enterpriseId });

  if (!hasRequiredEnterpriseInfoForAnalysis(collecting)) {
    throw new IaAnalyzeServiceError(
      'collecting_data_required_for_analysis',
      422,
      'collecting_data_required_for_analysis',
    );
  }

  const limit =
    typeof options?.limit === 'number' && options.limit > 0
      ? Math.min(options.limit, 100)
      : 50;

  const feedbacksForAnalysis = await fetchFeedbacksForAnalysis({
    enterpriseId,
    limit,
    scopeType: options?.scope_type,
    catalogItemId: options?.catalog_item_id?.trim() || null,
  });
  const feedbacksForExecution = applyExecutionFilter(feedbacksForAnalysis, options);

  if (feedbacksForExecution.length === 0) return null;

  if (feedbacksForExecution.length < MIN_FEEDBACKS_FOR_RELEVANT_ANALYSIS) {
    throw new IaAnalyzeServiceError(
      'insufficient_feedbacks_for_analysis',
      422,
      'insufficient_feedbacks_for_analysis',
    );
  }

  const alreadyAnalyzedIds = await fetchAlreadyAnalyzedFeedbackIds({
    feedbackIds: feedbacksForExecution.map((f) => f.id),
  });
  const feedbacksToAnalyze = feedbacksForExecution.filter((f) => !alreadyAnalyzedIds.has(f.id));

  if (feedbacksToAnalyze.length === 0) return null;

  const enterpriseContext = buildEnterpriseContext({ enterpriseName, collecting });
  const batches = buildAnalysisBatches(feedbacksToAnalyze, options);

  if (batches.length === 0) return null;

  return {
    enterpriseContext,
    batches,
    allowedFeedbackIds: new Set(feedbacksToAnalyze.map((f) => f.id)),
  };
}

/**
 * Analisa UM lote no serviço de IA e PERSISTE o resultado (idempotente via
 * `insertFeedbackAnalysisRows`). Devolve quantas linhas realmente gravou. É a
 * unidade de trabalho do worker: 1 lote = 1 chamada ao LLM = 1 passo de progresso.
 */
export async function runOneBatch(params: {
  enterpriseContext: ReturnType<typeof buildEnterpriseContext>;
  batch: ReturnType<typeof buildAnalysisBatches>[number];
  allowedFeedbackIds: Set<string>;
  creds?: IaCreds;
}): Promise<number> {
  const { enterpriseContext, batch, allowedFeedbackIds, creds } = params;

  const remotePayload: IaAnalyzeRemoteRunRequest = {
    enterprise_context: enterpriseContext,
    batches: [
      {
        scope_type: batch.scopeType,
        catalog_item_id: batch.catalogItemId,
        catalog_item_name: batch.catalogItemName,
        feedbacks: batch.feedbacks,
      },
    ],
  };

  const remoteResult = await runIaAnalyzeAnalysis(remotePayload, creds);

  const validSentimentsSet = new Set<IaAnalyzeSentiment>(['positive', 'negative', 'neutral']);
  const rowsToInsert = remoteResult.analyses
    .filter(
      (item) =>
        typeof item.feedback_id === 'string' &&
        validSentimentsSet.has(item.sentiment) &&
        allowedFeedbackIds.has(item.feedback_id),
    )
    .map((item) => ({
      feedback_id: item.feedback_id,
      sentiment: item.sentiment,
      categories: Array.isArray(item.categories) ? item.categories : [],
      keywords: Array.isArray(item.keywords) ? item.keywords : [],
      aspects: Array.isArray(item.aspects) ? item.aspects : [],
      sentiment_score: typeof item.sentiment_score === 'number' ? item.sentiment_score : null,
      confidence: typeof item.confidence === 'number' ? item.confidence : null,
    }));

  if (rowsToInsert.length === 0) return 0;

  const inserted = await insertFeedbackAnalysisRows({ rows: rowsToInsert });
  return inserted.length;
}

/**
 * Realiza a análise IA de feedbacks brutos, orquestrando todo o fluxo de validação, filtragem, batching e persistência dos resultados.
 *
 * Etapas principais:
 * 1. Busca contexto da empresa (dados obrigatórios para análise).
 * 2. Busca feedbacks para análise, aplica filtros de execução e valida quantidade mínima.
 * 3. Remove feedbacks já analisados para evitar duplicidade.
 * 4. Monta contexto e lotes para envio ao serviço remoto de IA.
 * 5. Envia para IA, filtra resultados válidos e insere no banco.
 * 6. Retorna quantidade e lista dos feedbacks analisados.
 *
 * Lança erros claros para casos de dados insuficientes ou problemas de processamento.
 *
 * Útil para garantir que apenas feedbacks válidos e inéditos sejam analisados, mantendo integridade e performance.
 */
export async function analyzeRawFeedbacks(params: {
  enterpriseId: string;
  options?: IaAnalyzeRawRunRequest;
}): Promise<IaAnalyzeRawRunResponse> {
  const prepared = await prepareAnalyzeRawJob(params);
  if (!prepared) {
    return { analyzedCount: 0, feedbacksAnalyzed: [] };
  }
  const { enterpriseContext, batches: analysisBatches, allowedFeedbackIds } = prepared;

  // Caminho síncrono: manda TODOS os lotes numa única chamada (o ia-analyze
  // paraleliza internamente) — preserva o comportamento atual. O worker (etapa 03)
  // usa runOneBatch por lote, com progresso e rate limit.
  const remotePayload: IaAnalyzeRemoteRunRequest = {
    enterprise_context: enterpriseContext,
    batches: analysisBatches.map((batch) => ({
      scope_type: batch.scopeType,
      catalog_item_id: batch.catalogItemId,
      catalog_item_name: batch.catalogItemName,
      feedbacks: batch.feedbacks,
    })),
  };

  const creds = await resolveIaCredsOrThrow(params.enterpriseId);
  const remoteResult = await runIaAnalyzeAnalysis(remotePayload, creds);

  const validSentimentsSet = new Set<IaAnalyzeSentiment>(['positive', 'negative', 'neutral']);

  const rowsToInsert = remoteResult.analyses
    .filter(
      (item) =>
        typeof item.feedback_id === 'string' &&
        validSentimentsSet.has(item.sentiment) &&
        allowedFeedbackIds.has(item.feedback_id),
    )
    .map((item) => ({
      feedback_id: item.feedback_id,
      sentiment: item.sentiment,
      categories: Array.isArray(item.categories) ? item.categories : [],
      keywords: Array.isArray(item.keywords) ? item.keywords : [],
      aspects: Array.isArray(item.aspects) ? item.aspects : [],
      sentiment_score: typeof item.sentiment_score === 'number' ? item.sentiment_score : null,
      confidence: typeof item.confidence === 'number' ? item.confidence : null,
    }));

  if (rowsToInsert.length === 0) {
    return { analyzedCount: 0, feedbacksAnalyzed: [] };
  }

  const feedbacksAnalyzed = await insertFeedbackAnalysisRows({ rows: rowsToInsert });

  return { analyzedCount: feedbacksAnalyzed.length, feedbacksAnalyzed };
}

/**
 * Recalcula e atualiza os insights globais e segmentados da IA com base nos feedbacks já analisados.
 *
 * Etapas principais:
 * 1. Busca contexto da empresa (dados obrigatórios para análise).
 * 2. Busca feedbacks já analisados e aplica filtros de execução.
 * 3. Valida quantidade mínima de feedbacks para relevância estatística.
 * 4. Monta contexto e lotes para envio ao serviço remoto de IA.
 * 5. Envia para IA, obtém novos insights/contextos e faz upsert no banco.
 * 6. Retorna insights globais e todos os contextos calculados.
 *
 * Lança erros claros para casos de dados insuficientes ou problemas de processamento.
 *
 * Útil para garantir que relatórios e dashboards estejam sempre atualizados com base na base de feedbacks mais recente.
 */
export async function regenerateFeedbackInsights(params: {
  enterpriseId: string;
  options?: IaAnalyzeRegenerateInsightsRequest;
}): Promise<IaAnalyzeRegenerateInsightsResponse> {
  const { enterpriseId, options } = params;

  const { collecting, enterpriseName } = await fetchEnterpriseContextForAnalysis({ enterpriseId });

  if (!hasRequiredEnterpriseInfoForAnalysis(collecting)) {
    throw new IaAnalyzeServiceError(
      'collecting_data_required_for_analysis',
      422,
      'collecting_data_required_for_analysis',
    );
  }

  // Busca já restrita ao escopo pedido: assim a janela de linhas vale DENTRO do
  // escopo e o filtro em memória abaixo só refina (defesa em profundidade).
  const analyzedFeedbacks = await fetchAlreadyAnalyzedFeedbacks({
    enterpriseId,
    scopeType: options?.scope_type,
    catalogItemId: options?.catalog_item_id?.trim() || null,
  });
  const feedbacksForExecution = applyExecutionFilter(analyzedFeedbacks, options);

  if (feedbacksForExecution.length === 0) {
    return { globalInsights: null, contexts: [], reportGenerated: false, fromCache: false };
  }

  if (feedbacksForExecution.length < MIN_FEEDBACKS_FOR_RELEVANT_ANALYSIS) {
    throw new IaAnalyzeServiceError(
      'insufficient_feedbacks_for_analysis',
      422,
      'insufficient_feedbacks_for_analysis',
    );
  }

  // Cache de leitura: se já existe relatório salvo para o escopo e NENHUM
  // feedback analisado é mais novo que ele, devolve o relatório salvo em vez de
  // reprocessar no LLM — resolve o "clicar de novo gasta cota à toa". `force`
  // ignora o cache (botão "forçar regeneração").
  if (!options?.force) {
    const cachedReports = await fetchFeedbackInsightsReports({
      enterpriseId,
      scopeType: options?.scope_type,
      catalogItemId: options?.catalog_item_id?.trim() || null,
    });

    if (!hasFeedbackNewerThanReports(feedbacksForExecution, cachedReports)) {
      const countsByScope = countAnalyzedByScope(feedbacksForExecution);
      const contexts = cachedReports.map((report) =>
        reportRowToContext(
          report,
          countsByScope.get(scopeKey(report.scope_type, report.catalog_item_id)) ?? 0,
        ),
      );
      const cachedGlobalInsights =
        contexts.find((ctx) => ctx.scope_type === 'COMPANY' && ctx.catalog_item_id === null)
          ?.globalInsights ??
        contexts[0]?.globalInsights ??
        null;

      console.info(
        `[ia-analyze:regenerate] cache hit — relatório servido sem chamar o LLM (escopo=${options?.scope_type ?? 'ALL'})`,
      );

      return {
        globalInsights: cachedGlobalInsights,
        contexts,
        reportGenerated: true,
        fromCache: true,
      };
    }
  }

  const enterpriseContext = buildEnterpriseContext({ enterpriseName, collecting });
  const analysisBatches = buildAnalysisBatches(feedbacksForExecution, options);

  if (analysisBatches.length === 0) {
    return { globalInsights: null, contexts: [], reportGenerated: false, fromCache: false };
  }

  const remotePayload: IaAnalyzeRemoteRunRequest = {
    enterprise_context: enterpriseContext,
    batches: analysisBatches.map((batch) => ({
      scope_type: batch.scopeType,
      catalog_item_id: batch.catalogItemId,
      catalog_item_name: batch.catalogItemName,
      feedbacks: batch.feedbacks,
    })),
  };

  const creds = await resolveIaCredsOrThrow(enterpriseId);
  const remoteResult = await runIaAnalyzeAnalysis(remotePayload, creds);
  const insightsContexts = remoteResult.contexts;

  const globalInsights =
    insightsContexts.find(
      (ctx) => ctx.scope_type === 'COMPANY' && ctx.catalog_item_id === null && ctx.globalInsights,
    )?.globalInsights ?? insightsContexts[0]?.globalInsights ?? null;

  const persistedContexts = await upsertFeedbackInsightsReports({
    enterpriseId,
    contexts: insightsContexts,
  });

  // "Gerou de verdade?" — com escopo pedido, exige um relatório salvo para
  // aquele scope_type+item; sem escopo, basta ter salvo algo. Isso é o que o
  // front usa para não dar "falso sucesso".
  const requestedItemId = options?.catalog_item_id?.trim() || null;
  const requestedScope = options?.scope_type;
  const reportGenerated = requestedScope
    ? persistedContexts.some(
        (ctx) =>
          ctx.scope_type === requestedScope &&
          (ctx.catalog_item_id ?? null) === requestedItemId,
      )
    : persistedContexts.length > 0;

  return { globalInsights, contexts: insightsContexts, reportGenerated, fromCache: false };
}
