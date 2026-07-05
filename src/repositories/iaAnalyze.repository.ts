import type {
  IaAnalyzeAnalyzedItem,
  IaAnalyzeContext,
} from '@feedback/lib-shared/interfaces/contracts/ia-analyze/analysis.contract';
import type { IaAnalyzeFeedbackInput } from '@feedback/lib-shared/interfaces/contracts/ia-analyze/input.contract';
import type {
  IaAnalyzeScopeType,
  IaAnalyzeSentiment,
} from '@feedback/lib-shared/interfaces/contracts/ia-analyze/scope.contract';
import { and, asc, desc, eq, exists, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { IaAnalyzeServiceError } from '../libs/iaAnalyze/errors.js';
import { normalizeScopeType } from '../libs/iaAnalyze/normalize.js';
import type { SavedInsightsReport } from '../libs/iaAnalyze/insightsCache.js';
import { resolveScopeCollectionPointIds } from './scope.repository.js';
import { fetchAnswersForFeedbacks } from './feedbackList.repository.js';
import type { CollectingDataContext, FeedbackAnalysisInsertRow } from '../types/iaAnalyze.types.js';
import { getDb } from '../db/client.js';
import {
  catalogItems,
  collectingDataEnterprise,
  collectionPoints,
  feedback,
  feedbackAnalysis,
  feedbackInsightsReport,
  feedbackSubquestionAnswers,
} from '../../drizzle/schema.js';
import { scopedByEnterprise, scopedFeedbackWhere } from '../db/tenantScope.js';

type AnswerValueKey = 'PESSIMO' | 'RUIM' | 'MEDIANA' | 'BOA' | 'OTIMA';

/** Subrespostas dinâmicas (isolamento transitivo via feedbackIds já escopados). */
async function fetchSubanswersForFeedbacks(feedbackIds: string[]) {
  if (feedbackIds.length === 0) return [];
  return getDb()
    .select({
      feedback_id: feedbackSubquestionAnswers.feedbackId,
      subquestion_id: feedbackSubquestionAnswers.subquestionId,
      subquestion_text_snapshot: feedbackSubquestionAnswers.subquestionTextSnapshot,
      answer_value: feedbackSubquestionAnswers.answerValue,
      answer_score: feedbackSubquestionAnswers.answerScore,
    })
    .from(feedbackSubquestionAnswers)
    .where(inArray(feedbackSubquestionAnswers.feedbackId, feedbackIds))
    .orderBy(asc(feedbackSubquestionAnswers.createdAt));
}

/**
 * Núcleo compartilhado por fetchFeedbacksForAnalysis (todos) e
 * fetchAlreadyAnalyzedFeedbacks (só os com análise). Monta os IaAnalyzeFeedbackInput
 * (feedback + ponto de coleta + item de catálogo + respostas/subrespostas),
 * SEMPRE tenant-scoped. O catálogo por id ganha `eq(enterprise_id)` explícito
 * (o Drizzle ignora a RLS — antes confiava nela).
 */
async function buildFeedbackInputs(params: {
  enterpriseId: string;
  scopedCollectionPointIds: string[] | null;
  limit: number;
  onlyAnalyzed: boolean;
}): Promise<IaAnalyzeFeedbackInput[]> {
  const { enterpriseId, scopedCollectionPointIds, limit, onlyAnalyzed } = params;
  const db = getDb();

  const conds: SQL[] = [scopedFeedbackWhere(enterpriseId, scopedCollectionPointIds)];
  if (onlyAnalyzed) {
    conds.push(
      exists(
        db.select({ x: sql`1` }).from(feedbackAnalysis).where(eq(feedbackAnalysis.feedbackId, feedback.id)),
      ),
    );
  }

  const feedbackRows = await db
    .select({
      id: feedback.id,
      message: feedback.message,
      rating: feedback.rating,
      createdAt: feedback.createdAt,
      cpId: collectionPoints.id,
      cpName: collectionPoints.name,
      cpType: collectionPoints.type,
      cpIdentifier: collectionPoints.identifier,
      cpCatalogItemId: collectionPoints.catalogItemId,
    })
    .from(feedback)
    .leftJoin(collectionPoints, eq(collectionPoints.id, feedback.collectionPointId))
    .where(conds.length === 1 ? conds[0] : and(...conds))
    .orderBy(desc(feedback.createdAt))
    .limit(limit);

  // Enriquecimento de catálogo (só itens não-COMPANY), COM eq(enterprise_id).
  const catalogItemIds = [
    ...new Set(
      feedbackRows
        .map((r) => r.cpCatalogItemId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];

  const catalogItemById = new Map<
    string,
    { id: string; name: string; kind: 'PRODUCT' | 'SERVICE' | 'DEPARTMENT'; description: string | null }
  >();

  if (catalogItemIds.length > 0) {
    const catalogRows = await db
      .select({
        id: catalogItems.id,
        name: catalogItems.name,
        kind: catalogItems.kind,
        description: catalogItems.description,
      })
      .from(catalogItems)
      .where(scopedByEnterprise(catalogItems.enterpriseId, enterpriseId, inArray(catalogItems.id, catalogItemIds)));

    for (const row of catalogRows) {
      const scope = normalizeScopeType(row.kind);
      if (scope === 'COMPANY') continue;
      catalogItemById.set(row.id, {
        id: row.id,
        name: row.name,
        kind: scope,
        description: row.description ?? null,
      });
    }
  }

  // Respostas e subrespostas dinâmicas.
  const feedbackIds = feedbackRows
    .map((r) => r.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  const answersByFeedbackId = new Map<
    string,
    Array<{ question_id: string; question_text_snapshot: string; answer_value: AnswerValueKey; answer_score: number }>
  >();
  const subanswersByFeedbackId = new Map<
    string,
    Array<{ subquestion_id: string; subquestion_text_snapshot: string; answer_value: AnswerValueKey; answer_score: number }>
  >();

  if (feedbackIds.length > 0) {
    for (const a of await fetchAnswersForFeedbacks(feedbackIds)) {
      const cur = answersByFeedbackId.get(a.feedback_id) ?? [];
      cur.push({
        question_id: a.question_id,
        question_text_snapshot: a.question_text_snapshot,
        answer_value: a.answer_value as AnswerValueKey,
        answer_score: a.answer_score,
      });
      answersByFeedbackId.set(a.feedback_id, cur);
    }
    for (const s of await fetchSubanswersForFeedbacks(feedbackIds)) {
      const cur = subanswersByFeedbackId.get(s.feedback_id) ?? [];
      cur.push({
        subquestion_id: s.subquestion_id,
        subquestion_text_snapshot: s.subquestion_text_snapshot,
        answer_value: s.answer_value as AnswerValueKey,
        answer_score: s.answer_score,
      });
      subanswersByFeedbackId.set(s.feedback_id, cur);
    }
  }

  return feedbackRows.map((r) => {
    const catalogItemId = typeof r.cpCatalogItemId === 'string' ? r.cpCatalogItemId : null;
    const catalogItem = catalogItemId ? (catalogItemById.get(catalogItemId) ?? null) : null;
    const scopeType = normalizeScopeType(catalogItem?.kind ?? null);

    return {
      id: r.id,
      message: r.message,
      rating: r.rating ?? null,
      created_at: r.createdAt ?? null,
      scope_type: scopeType,
      collection_point: {
        id: r.cpId ?? null,
        name: r.cpName ?? null,
        type: r.cpType ?? null,
        identifier: r.cpIdentifier ?? null,
      },
      catalog_item: catalogItem,
      dynamic_answers: answersByFeedbackId.get(r.id) ?? [],
      dynamic_subanswers: subanswersByFeedbackId.get(r.id) ?? [],
    } satisfies IaAnalyzeFeedbackInput;
  });
}

/** Feedbacks (todos) prontos para análise IA, restritos ao escopo. */
export async function fetchFeedbacksForAnalysis(params: {
  enterpriseId: string;
  limit: number;
  scopeType?: IaAnalyzeScopeType;
  catalogItemId?: string | null;
}): Promise<IaAnalyzeFeedbackInput[]> {
  const { enterpriseId, limit, scopeType, catalogItemId = null } = params;

  const scopeResolution = await resolveScopeCollectionPointIds({ enterpriseId, scopeType, catalogItemId });
  if (scopeResolution.error) {
    throw new IaAnalyzeServiceError('Failed to resolve scope for feedbacks', 500, 'failed_to_fetch_feedbacks_for_ia');
  }
  if (scopeResolution.ids && scopeResolution.ids.length === 0) return [];

  return buildFeedbackInputs({
    enterpriseId,
    scopedCollectionPointIds: scopeResolution.ids,
    limit,
    onlyAnalyzed: false,
  });
}

/** Feedbacks JÁ ANALISADOS do escopo (exists em feedback_analysis). */
export async function fetchAlreadyAnalyzedFeedbacks(params: {
  enterpriseId: string;
  scopeType?: IaAnalyzeScopeType;
  catalogItemId?: string | null;
  limit?: number;
}): Promise<IaAnalyzeFeedbackInput[]> {
  const { enterpriseId, scopeType, catalogItemId = null, limit = 100 } = params;

  const scopeResolution = await resolveScopeCollectionPointIds({ enterpriseId, scopeType, catalogItemId });
  if (scopeResolution.error) {
    throw new IaAnalyzeServiceError('Failed to resolve scope for analyzed feedbacks', 500, 'failed_to_fetch_analyzed_feedbacks');
  }
  if (scopeResolution.ids && scopeResolution.ids.length === 0) return [];

  return buildFeedbackInputs({
    enterpriseId,
    scopedCollectionPointIds: scopeResolution.ids,
    limit,
    onlyAnalyzed: true,
  });
}

/** Contexto da empresa: dados de coleta + nome (via view enterprise_public). */
export async function fetchEnterpriseContextForAnalysis(params: {
  enterpriseId: string;
}): Promise<{ collecting: CollectingDataContext | null; enterpriseName: string | null }> {
  const { enterpriseId } = params;
  const db = getDb();

  const collectingRows = await db
    .select({
      company_objective: collectingDataEnterprise.companyObjective,
      analytics_goal: collectingDataEnterprise.analyticsGoal,
      business_summary: collectingDataEnterprise.businessSummary,
      main_products_or_services: collectingDataEnterprise.mainProductsOrServices,
    })
    .from(collectingDataEnterprise)
    .where(eq(collectingDataEnterprise.enterpriseId, enterpriseId))
    .limit(1);

  // Nome via view enterprise_public (hoje resolve por auth.users; forward-compat
  // quando a view for reescrita para public.user no fechamento da Fase 2).
  const nameRows = await db.execute(
    sql`SELECT name FROM public.enterprise_public WHERE id = ${enterpriseId} LIMIT 1`,
  );
  const enterpriseName = (nameRows[0] as { name?: string | null } | undefined)?.name ?? null;

  return { collecting: (collectingRows[0] as CollectingDataContext | null) ?? null, enterpriseName };
}

/** Ids de feedbacks que já têm análise salva (idempotência do analyze-raw). */
export async function fetchAlreadyAnalyzedFeedbackIds(params: {
  feedbackIds: string[];
}): Promise<Set<string>> {
  const { feedbackIds } = params;
  if (feedbackIds.length === 0) return new Set<string>();

  const rows = await getDb()
    .select({ feedbackId: feedbackAnalysis.feedbackId })
    .from(feedbackAnalysis)
    .where(inArray(feedbackAnalysis.feedbackId, feedbackIds));

  return new Set(
    rows.map((r) => r.feedbackId).filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
}

/** Insere as análises e devolve os itens essenciais (isolamento transitivo). */
export async function insertFeedbackAnalysisRows(params: {
  rows: FeedbackAnalysisInsertRow[];
}): Promise<IaAnalyzeAnalyzedItem[]> {
  const { rows } = params;
  if (rows.length === 0) return [];

  const values = rows.map((r) => ({
    feedbackId: r.feedback_id,
    sentiment: r.sentiment,
    categories: r.categories,
    keywords: r.keywords,
    aspects: r.aspects ?? [],
    sentimentScore: r.sentiment_score != null ? String(r.sentiment_score) : null,
    confidence: r.confidence != null ? String(r.confidence) : null,
  }));

  const inserted = await getDb()
    .insert(feedbackAnalysis)
    .values(values)
    .returning({
      id: feedbackAnalysis.id,
      feedbackId: feedbackAnalysis.feedbackId,
      sentiment: feedbackAnalysis.sentiment,
      categories: feedbackAnalysis.categories,
      keywords: feedbackAnalysis.keywords,
    });

  return inserted.map((row) => ({
    id: row.id,
    feedback_id: row.feedbackId,
    sentiment: row.sentiment as IaAnalyzeSentiment,
    categories: row.categories ?? [],
    keywords: row.keywords ?? [],
  }));
}

/** Upsert dos relatórios de insights por escopo (unicidade composta). */
export async function upsertFeedbackInsightsReports(params: {
  enterpriseId: string;
  contexts: IaAnalyzeContext[];
}): Promise<IaAnalyzeContext[]> {
  const { enterpriseId, contexts } = params;
  const persisted: IaAnalyzeContext[] = [];

  for (const context of contexts) {
    const summary = context.globalInsights?.summary?.trim() || null;
    const recommendations =
      context.globalInsights?.recommendations?.filter((value: string) => String(value ?? '').trim()) ?? [];

    if (!summary && recommendations.length === 0) continue;

    const now = new Date().toISOString();
    try {
      await getDb()
        .insert(feedbackInsightsReport)
        .values({
          enterpriseId,
          scopeType: context.scope_type,
          catalogItemId: context.catalog_item_id,
          catalogItemName: context.catalog_item_name,
          summary,
          recommendations,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            feedbackInsightsReport.enterpriseId,
            feedbackInsightsReport.scopeType,
            feedbackInsightsReport.catalogItemId,
          ],
          set: {
            summary,
            recommendations,
            catalogItemName: context.catalog_item_name,
            updatedAt: now,
          },
        });
      persisted.push(context);
    } catch (error) {
      console.error('Falha ao salvar feedback_insights_report', error);
      continue;
    }
  }

  return persisted;
}

/** Relatórios salvos do escopo (base do cache de leitura da regeneração). */
export async function fetchFeedbackInsightsReports(params: {
  enterpriseId: string;
  scopeType?: IaAnalyzeScopeType;
  catalogItemId?: string | null;
}): Promise<SavedInsightsReport[]> {
  const { enterpriseId, scopeType, catalogItemId = null } = params;

  const conds: SQL[] = [eq(feedbackInsightsReport.enterpriseId, enterpriseId)];
  if (scopeType) {
    conds.push(eq(feedbackInsightsReport.scopeType, scopeType));
    conds.push(
      catalogItemId
        ? eq(feedbackInsightsReport.catalogItemId, catalogItemId)
        : isNull(feedbackInsightsReport.catalogItemId),
    );
  }

  const rows = await getDb()
    .select({
      scope_type: feedbackInsightsReport.scopeType,
      catalog_item_id: feedbackInsightsReport.catalogItemId,
      catalog_item_name: feedbackInsightsReport.catalogItemName,
      summary: feedbackInsightsReport.summary,
      recommendations: feedbackInsightsReport.recommendations,
      updated_at: feedbackInsightsReport.updatedAt,
    })
    .from(feedbackInsightsReport)
    .where(conds.length === 1 ? conds[0] : and(...conds));

  return rows as SavedInsightsReport[];
}
