import type { Request, Response } from 'express';
import {
  API_ERROR_ENTERPRISE_NOT_FOUND,
  API_ERROR_FAILED_TO_FETCH_FEEDBACK_ANALYSIS,
  API_ERROR_FAILED_TO_FETCH_STATS,
  API_ERROR_INTERNAL_SERVER_ERROR,
} from '../../config/errors.js';
import { normalizeFeedbackAnalysisRows } from '../../libs/iaAnalyze/normalize.js';
import { resolveScopeCollectionPointIds } from '../../repositories/scope.repository.js';
import { resolveEnterpriseIdByUser } from '../../repositories/enterprise.repository.js';
import { fetchScopedInsightsReport } from '../../repositories/feedbackInsights.repository.js';
import { sendTypedError } from '../../utils/sendTypedError.js';
import {
  ratingStats,
  csatTopTwoBox,
  netSatisfaction,
  netSentimentScore,
  confidenceTier,
  wilsonInterval,
  wilsonLowerBound,
} from '../../libs/statistics/index.js';
import {
  fetchScopedRatingAggregates,
  fetchScopedAnalysisAggregates,
} from '../../repositories/feedbackStats.repository.js';
import {
  fetchQuestionDefsScoped,
  fetchSubquestionDefsScoped,
} from '../../repositories/feedbackQuestions.repository.js';
import {
  resolveCategoryCollectionPointIds,
  countScopedFeedbacks,
  fetchScopedFeedbackPage,
  fetchCatalogItemsByIds,
  fetchAnswersForFeedbacks,
} from '../../repositories/feedbackList.repository.js';
import { fetchScopedFeedbackAnalysisRows } from '../../repositories/feedbackAnalysis.repository.js';
import { inArray } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import {
  feedback,
  feedbackQuestionAnswers,
  feedbackSubquestionAnswers,
} from '../../../drizzle/schema.js';
import { scopedFeedbackWhere } from '../../db/tenantScope.js';

type FeedbackCollectionPoint = {
  id?: string;
  name?: string;
  type?: string;
  identifier?: string | null;
  catalog_item_id?: string | null;
};

type CatalogItemRow = {
  id: string;
  name: string;
  kind: string | null;
};

type FeedbackListRow = {
  id: string;
  collection_points: FeedbackCollectionPoint | FeedbackCollectionPoint[] | null;
} & Record<string, unknown>;

function resolveCollectionPoint(
  collectionPointRaw: FeedbackCollectionPoint | FeedbackCollectionPoint[] | null | undefined,
) {
  if (Array.isArray(collectionPointRaw)) return collectionPointRaw[0] ?? null;
  return collectionPointRaw ?? null;
}

function parseInsightScopeType(rawValue: unknown) {
  const normalized = String(rawValue ?? '').trim().toUpperCase();
  if (
    normalized === 'COMPANY' ||
    normalized === 'PRODUCT' ||
    normalized === 'SERVICE' ||
    normalized === 'DEPARTMENT'
  ) {
    return normalized;
  }
  return undefined;
}

export async function getFeedbacksController(req: Request, res: Response) {
  const user = req.user!;

  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 10;
  const offset = (page - 1) * limit;

  const rating = req.query.rating ? parseInt(req.query.rating as string) : null;
  const search = (req.query.search as string) || '';
  const item = String(req.query.item ?? '').trim();
  const categoryRaw = String(req.query.category ?? '').trim().toUpperCase();

  const category =
    categoryRaw === 'COMPANY' ||
    categoryRaw === 'PRODUCT' ||
    categoryRaw === 'SERVICE' ||
    categoryRaw === 'DEPARTMENT'
      ? categoryRaw
      : null;

  try {
    const enterpriseId = req.enterpriseId ?? (await resolveEnterpriseIdByUser(user.id));
    if (!enterpriseId) {
      return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);
    }

    const filteredCollectionPointIds = await resolveCategoryCollectionPointIds({
      enterpriseId,
      category,
      item,
    });

    if (filteredCollectionPointIds && filteredCollectionPointIds.length === 0) {
      return res.json({
        feedbacks: [],
        pagination: {
          currentPage: page,
          totalPages: 0,
          totalItems: 0,
          itemsPerPage: limit,
          hasNextPage: false,
          hasPreviousPage: page > 1,
        },
      });
    }

    const listFilter = { rating, search, collectionPointIds: filteredCollectionPointIds };
    const count = await countScopedFeedbacks(enterpriseId, listFilter);
    const totalPages = Math.ceil((count || 0) / limit);
    const feedbackRows = (await fetchScopedFeedbackPage({
      enterpriseId,
      filter: listFilter,
      limit,
      offset,
    })) as FeedbackListRow[];

    const catalogItemIds = Array.from(
      new Set(
        feedbackRows
          .map((feedback) => resolveCollectionPoint(feedback.collection_points)?.catalog_item_id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    );

    let catalogItemById = new Map<string, { name: string; kind: 'PRODUCT' | 'SERVICE' | 'DEPARTMENT' }>();

    if (catalogItemIds.length > 0) {
      const catalogRows = await fetchCatalogItemsByIds(enterpriseId, catalogItemIds);

      catalogItemById = new Map(
        ((catalogRows ?? []) as CatalogItemRow[])
          .map((row) => {
            const normalizedKind = String(row.kind ?? '').toUpperCase();
            const kind =
              normalizedKind === 'PRODUCT' ||
              normalizedKind === 'SERVICE' ||
              normalizedKind === 'DEPARTMENT'
                ? normalizedKind
                : null;
            if (!kind || typeof row.id !== 'string') return null;
            return [row.id, { name: row.name, kind }] as const;
          })
          .filter((entry): entry is readonly [string, { name: string; kind: 'PRODUCT' | 'SERVICE' | 'DEPARTMENT' }] => Boolean(entry)),
      );
    }

    const normalizedFeedbacks = feedbackRows.map((feedback) => {
      const collectionPoint = resolveCollectionPoint(feedback.collection_points);
      if (!collectionPoint) return feedback;

      const catalogItem = collectionPoint.catalog_item_id
        ? (catalogItemById.get(collectionPoint.catalog_item_id) ?? null)
        : null;

      return {
        ...feedback,
        collection_points: {
          ...collectionPoint,
          catalog_item_name: catalogItem?.name ?? null,
          catalog_item_kind: catalogItem?.kind ?? null,
          catalog_items: catalogItem,
        },
      };
    });

    const feedbackIds = normalizedFeedbacks
      .map((feedback) => feedback.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    const answersByFeedbackId = new Map<
      string,
      Array<{
        question_id: string;
        question_text_snapshot: string;
        answer_value: 'PESSIMO' | 'RUIM' | 'MEDIANA' | 'BOA' | 'OTIMA';
        answer_score: number;
      }>
    >();

    if (feedbackIds.length > 0) {
      const answerRows = await fetchAnswersForFeedbacks(feedbackIds);
      for (const row of answerRows) {
        const current = answersByFeedbackId.get(row.feedback_id) ?? [];
        current.push({
          question_id: row.question_id,
          question_text_snapshot: row.question_text_snapshot,
          answer_value: row.answer_value as 'PESSIMO' | 'RUIM' | 'MEDIANA' | 'BOA' | 'OTIMA',
          answer_score: row.answer_score,
        });
        answersByFeedbackId.set(row.feedback_id, current);
      }
    }

    const normalizedFeedbacksWithAnswers = normalizedFeedbacks.map((feedback) => ({
      ...feedback,
      feedback_question_answers: answersByFeedbackId.get(feedback.id) ?? [],
    }));

    return res.json({
      feedbacks: normalizedFeedbacksWithAnswers,
      pagination: {
        currentPage: page,
        totalPages,
        totalItems: count || 0,
        itemsPerPage: limit,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    });
  } catch (error) {
    console.error('Erro ao buscar feedbacks:', error);
    return sendTypedError(res, 500, API_ERROR_INTERNAL_SERVER_ERROR);
  }
}

export async function getFeedbacksStatsController(req: Request, res: Response) {
  const user = req.user!;

  const scopeType = parseInsightScopeType(req.query.scope_type);
  const catalogItemId = String(req.query.catalog_item_id ?? '').trim() || null;

  try {
    const enterpriseId = req.enterpriseId ?? (await resolveEnterpriseIdByUser(user.id));
    if (!enterpriseId) {
      return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);
    }

    // Métricas filtradas pelo escopo selecionado no header (Geral = só o QR da empresa).
    const scopeResolution = await resolveScopeCollectionPointIds({
      enterpriseId,
      scopeType,
      catalogItemId,
    });

    if (scopeResolution.error) {
      return sendTypedError(res, 500, API_ERROR_FAILED_TO_FETCH_STATS);
    }

    const filteredCollectionPointIds = scopeResolution.ids;

    // Agregações servidas via DRIZZLE, com a contagem feita NO BANCO (GROUP BY),
    // e SEMPRE com filtro explícito por enterprise_id (isolamento multi-tenant na
    // aplicação — o Drizzle acessa com role que ignora a RLS). Ver
    // src/db/tenantScope.ts e src/repositories/feedbackStats.repository.ts.
    const ratingAgg = await fetchScopedRatingAggregates({
      enterpriseId,
      collectionPointIds: filteredCollectionPointIds,
    });
    const analysisAgg = await fetchScopedAnalysisAggregates({
      enterpriseId,
      collectionPointIds: filteredCollectionPointIds,
    });

    const totalFeedbacks = ratingAgg.totalFeedbacks;
    const averageRating = totalFeedbacks > 0 ? ratingAgg.ratingSum / totalFeedbacks : 0;
    const ratingDistribution = ratingAgg.ratingDistribution;

    // Subconjunto analisado pela IA: total, análise mais recente (trava o
    // "Gerar insights") e a distribuição de sentimento (lente "texto").
    const totalAnalyzed = analysisAgg.totalAnalyzed;
    const latestAnalysisAt = analysisAgg.latestAnalysisAt;
    const aiCounts = analysisAgg.aiCounts;
    const pendingCount = totalFeedbacks - totalAnalyzed;

    // Lente SATISFAÇÃO (estrelas): média+IC t, Net Satisfaction e CSAT Top-2-Box.
    const satisfaction = ratingStats(ratingDistribution);
    const top2 = ratingDistribution[4] + ratingDistribution[5];
    const bottom2 = ratingDistribution[1] + ratingDistribution[2];

    return res.json({
      totalFeedbacks,
      averageRating: Math.round(averageRating * 10) / 10,
      ratingDistribution,
      // Distribuição por estrela (lente satisfação; mantida por compatibilidade).
      sentimentBreakdown: {
        positive: ratingDistribution[4] + ratingDistribution[5],
        neutral: ratingDistribution[3],
        negative: ratingDistribution[1] + ratingDistribution[2],
      },
      totalAnalyzed,
      pendingCount,
      latestAnalysisAt,
      // Lente SATISFAÇÃO (estrelas)
      starMean: satisfaction.mean,
      starMeanCI: satisfaction.ci,
      netSatisfaction: netSatisfaction(top2, bottom2, totalFeedbacks),
      csat: csatTopTwoBox(ratingDistribution),
      confidenceTier: confidenceTier(totalFeedbacks),
      // Lente SENTIMENTO (IA/texto) sobre o subconjunto analisado
      aiSentiment:
        totalAnalyzed > 0
          ? {
              positive: aiCounts.positive,
              neutral: aiCounts.neutral,
              negative: aiCounts.negative,
              netSentimentScore: netSentimentScore(aiCounts.positive, aiCounts.negative, totalAnalyzed),
              confidenceTier: confidenceTier(totalAnalyzed),
            }
          : undefined,
    });
  } catch (error) {
    console.error('Erro ao buscar estatísticas:', error);
    return sendTypedError(res, 500, API_ERROR_INTERNAL_SERVER_ERROR);
  }
}

export async function getFeedbacksInsightsReportController(req: Request, res: Response) {
  const user = req.user!;
  const scopeType = parseInsightScopeType(req.query.scope_type) ?? 'COMPANY';
  const catalogItemId = String(req.query.catalog_item_id ?? '').trim() || null;

  try {
    const enterpriseId = req.enterpriseId ?? (await resolveEnterpriseIdByUser(user.id));
    if (!enterpriseId) {
      return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);
    }

    // Com o schema atual `scope_type` está sempre presente → a query escopada é
    // autoritativa (o antigo fallback legado por empresa, sem escopo, foi removido).
    const report = await fetchScopedInsightsReport({ enterpriseId, scopeType, catalogItemId });

    if (!report) {
      return res.json({ summary: null, recommendations: [], updatedAt: null, scopeType, catalogItemId });
    }

    return res.json({
      summary: report.summary ?? null,
      recommendations: (report.recommendations ?? []).filter((rec) => !!rec && rec.trim().length > 0),
      updatedAt: report.updatedAt ?? null,
      scopeType: report.scopeType ?? scopeType,
      catalogItemId: report.catalogItemId ?? catalogItemId,
    });
  } catch (error) {
    console.error('Erro ao buscar relatório de insights (IA):', error);
    return sendTypedError(res, 500, API_ERROR_INTERNAL_SERVER_ERROR);
  }
}

export async function getFeedbacksAnalysisController(req: Request, res: Response) {
  const user = req.user!;

  const sentimentFilter = (req.query.sentiment as 'positive' | 'neutral' | 'negative' | undefined) ?? undefined;
  const scopeType = parseInsightScopeType(req.query.scope_type);
  const catalogItemId = String(req.query.catalog_item_id ?? '').trim() || null;

  try {
    const enterpriseId = req.enterpriseId ?? (await resolveEnterpriseIdByUser(user.id));
    if (!enterpriseId) {
      return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);
    }

    const emptyResult = {
      items: [],
      summary: { totalAnalyzed: 0, sentiments: { positive: 0, neutral: 0, negative: 0 }, topCategories: [], topKeywords: [] },
    };

    const scopeResolution = await resolveScopeCollectionPointIds({
      enterpriseId,
      scopeType,
      catalogItemId,
    });

    if (scopeResolution.error) {
      return sendTypedError(res, 500, API_ERROR_FAILED_TO_FETCH_FEEDBACK_ANALYSIS);
    }

    const filteredCollectionPointIds = scopeResolution.ids;

    if (filteredCollectionPointIds && filteredCollectionPointIds.length === 0) {
      return res.json(emptyResult);
    }

    const data = await fetchScopedFeedbackAnalysisRows({
      enterpriseId,
      collectionPointIds: filteredCollectionPointIds,
      sentiment: sentimentFilter,
    });

    const itemsRaw = normalizeFeedbackAnalysisRows(data);
    if (itemsRaw.length === 0) return res.json(emptyResult);

    const items = itemsRaw.map((row) => {
      const sentiment = row.feedback_analysis.sentiment;
      const rating = row.rating;
      const starBucket =
        rating == null ? null : rating >= 4 ? 'positive' : rating === 3 ? 'neutral' : 'negative';
      const discrepancy: 'silent_detractor' | 'rating_misuse' | null =
        starBucket === 'positive' && sentiment === 'negative'
          ? 'silent_detractor'
          : starBucket === 'negative' && sentiment === 'positive'
            ? 'rating_misuse'
            : null;
      return {
        id: row.id,
        message: row.message,
        rating,
        created_at: row.created_at,
        sentiment,
        categories: row.feedback_analysis.categories ?? [],
        keywords: row.feedback_analysis.keywords ?? [],
        discrepancy,
        aspects: Array.isArray(row.feedback_analysis.aspects) ? row.feedback_analysis.aspects : [],
        sentiment_score: row.feedback_analysis.sentiment_score ?? null,
        confidence: row.feedback_analysis.confidence ?? null,
      };
    });

    const sentiments = { positive: 0, neutral: 0, negative: 0 };
    const categoryCounts: Record<string, number> = {};
    const keywordCounts: Record<string, number> = {};
    type AspectBucket = { positive: number; neutral: number; negative: number };
    const aspectCounts: Record<string, AspectBucket> = {};

    for (const item of items) {
      sentiments[item.sentiment]++;
      for (const category of item.categories) {
        const key = category.trim().toLowerCase();
        if (key) categoryCounts[key] = (categoryCounts[key] ?? 0) + 1;
      }
      for (const keyword of item.keywords) {
        const key = keyword.trim().toLowerCase();
        if (key) keywordCounts[key] = (keywordCounts[key] ?? 0) + 1;
      }
      for (const aspect of item.aspects) {
        const key = aspect.aspect.trim().toLowerCase();
        if (!key) continue;
        const bucket = (aspectCounts[key] ??= { positive: 0, neutral: 0, negative: 0 });
        bucket[aspect.sentiment]++;
      }
    }

    const totalAnalyzed = items.length;

    // Ranqueia termos pelo limite inferior de Wilson (justo p/ amostra pequena),
    // mantendo a contagem crua e anexando proporção + IC.
    const rankTerms = (counts: Record<string, number>) =>
      Object.entries(counts)
        .map(([name, count]) => ({
          name,
          count,
          proportion: totalAnalyzed > 0 ? count / totalAnalyzed : 0,
          ci: wilsonInterval(count, totalAnalyzed),
        }))
        .sort(
          (a, b) =>
            wilsonLowerBound(b.count, totalAnalyzed) - wilsonLowerBound(a.count, totalAnalyzed) ||
            b.count - a.count,
        )
        .slice(0, 10);

    // Aspectos (ABSA) agregados, ranqueados por IMPACTO (volume × |NSS|), com
    // gate de menção mínima para não destacar aspecto de amostra ínfima.
    const MIN_ASPECT_MENTIONS = 3;
    const aspectSentiments = Object.entries(aspectCounts)
      .map(([aspect, bucket]) => {
        const count = bucket.positive + bucket.neutral + bucket.negative;
        return {
          aspect,
          positive: bucket.positive,
          neutral: bucket.neutral,
          negative: bucket.negative,
          count,
          netSentimentScore: netSentimentScore(bucket.positive, bucket.negative, count),
          ci: wilsonInterval(bucket.positive, count),
        };
      })
      .filter((a) => a.count >= MIN_ASPECT_MENTIONS)
      .sort(
        (a, b) =>
          b.count * Math.abs(b.netSentimentScore) - a.count * Math.abs(a.netSentimentScore),
      )
      .slice(0, 12);

    return res.json({
      items,
      summary: {
        totalAnalyzed,
        sentiments,
        topCategories: rankTerms(categoryCounts),
        topKeywords: rankTerms(keywordCounts),
        netSentimentScore: netSentimentScore(sentiments.positive, sentiments.negative, totalAnalyzed),
        sentimentCIs: {
          positive: wilsonInterval(sentiments.positive, totalAnalyzed),
          neutral: wilsonInterval(sentiments.neutral, totalAnalyzed),
          negative: wilsonInterval(sentiments.negative, totalAnalyzed),
        },
        confidenceTier: confidenceTier(totalAnalyzed),
        aspectSentiments,
      },
    });
  } catch (error) {
    console.error('Erro ao buscar análises de feedbacks (IA):', error);
    return sendTypedError(res, 500, API_ERROR_INTERNAL_SERVER_ERROR);
  }
}

type AnswerValueKey = 'PESSIMO' | 'RUIM' | 'MEDIANA' | 'BOA' | 'OTIMA';

/**
 * Estado de uma redação de pergunta/subpergunta nas métricas:
 * - `current`: ativa e com o texto atual da config (aparece em "Atuais").
 * - `deactivated`: a config ainda tem esta redação, mas está desativada (toggle off).
 *   Reativar a traz de volta para "Atuais" com todo o histórico (id estável).
 * - `past`: redação antiga (texto editado) ou pergunta removida da config.
 */
type QuestionMetricStatus = 'current' | 'deactivated' | 'past';

type ConfigEntry = { text: string; isActive: boolean } | undefined;

type QuestionAnswerAgg = {
  /** question_id ou subquestion_id (estável; a redação pode mudar com o tempo). */
  id: string;
  /** Snapshot da redação exata respondida pelo cliente (já trimada). */
  text: string;
  counts: Record<number, number>;
  distribution: Record<AnswerValueKey, number>;
};

/**
 * Separador para a chave composta (id + redação). Cada redação distinta de uma
 * mesma pergunta vira uma entrada própria — assim "Atuais" e "Antigas" não se misturam.
 */
const AGG_KEY_SEP = String.fromCharCode(1);

function newAnswerAgg(id: string, text: string): QuestionAnswerAgg {
  return {
    id,
    text,
    counts: {},
    distribution: { PESSIMO: 0, RUIM: 0, MEDIANA: 0, BOA: 0, OTIMA: 0 },
  };
}

function addAnswerToAgg(
  map: Map<string, QuestionAnswerAgg>,
  id: string,
  text: string,
  answerValue: AnswerValueKey,
  answerScore: number,
) {
  const key = `${id}${AGG_KEY_SEP}${text}`;
  const acc = map.get(key) ?? newAnswerAgg(id, text);
  acc.counts[answerScore] = (acc.counts[answerScore] ?? 0) + 1;
  acc.distribution[answerValue] += 1;
  map.set(key, acc);
}

function aggToMetricFields(agg: QuestionAnswerAgg) {
  const rs = ratingStats(agg.counts);
  return {
    count: rs.n,
    mean: rs.mean,
    ci: rs.ci,
    satisfiedPct: csatTopTwoBox(agg.counts).pct,
    distribution: agg.distribution,
    confidenceTier: confidenceTier(rs.n),
  };
}

/**
 * Métricas por pergunta/subpergunta (escala 1–5), agregadas no escopo: nota
 * média + IC, % satisfeitos (BOA+ÓTIMA), distribuição e camada de confiança.
 * Determinístico — só estatística sobre as respostas estruturadas. Ordenado
 * pior→melhor (menor nota no topo).
 */
export async function getFeedbacksQuestionsController(req: Request, res: Response) {
  const user = req.user!;

  const scopeType = parseInsightScopeType(req.query.scope_type);
  const catalogItemId = String(req.query.catalog_item_id ?? '').trim() || null;

  try {
    const enterpriseId = req.enterpriseId ?? (await resolveEnterpriseIdByUser(user.id));
    if (!enterpriseId) {
      return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);
    }

    const scopeResolution = await resolveScopeCollectionPointIds({
      enterpriseId,
      scopeType,
      catalogItemId,
    });

    if (scopeResolution.error) {
      return sendTypedError(res, 500, API_ERROR_FAILED_TO_FETCH_STATS);
    }

    const filteredCollectionPointIds = scopeResolution.ids;
    if (filteredCollectionPointIds && filteredCollectionPointIds.length === 0) {
      return res.json({ questions: [] });
    }

    // Feedbacks do escopo (SEMPRE por enterprise_id via scopedFeedbackWhere).
    const feedbackRows = await getDb()
      .select({ id: feedback.id })
      .from(feedback)
      .where(scopedFeedbackWhere(enterpriseId, filteredCollectionPointIds));

    const feedbackIds = feedbackRows.map((f) => f.id);
    if (feedbackIds.length === 0) return res.json({ questions: [] });

    // Respostas das perguntas → agrega por pergunta. Isolamento transitivo: os
    // feedbackIds já vêm tenant-scoped.
    const answerRows = await getDb()
      .select({
        question_id: feedbackQuestionAnswers.questionId,
        question_text_snapshot: feedbackQuestionAnswers.questionTextSnapshot,
        answer_value: feedbackQuestionAnswers.answerValue,
        answer_score: feedbackQuestionAnswers.answerScore,
      })
      .from(feedbackQuestionAnswers)
      .where(inArray(feedbackQuestionAnswers.feedbackId, feedbackIds));

    // Agrupa as respostas por (question_id + redação do snapshot): cada redação
    // distinta vira uma entrada própria, para separar "atuais" de "antigas".
    const questionAgg = new Map<string, QuestionAnswerAgg>();
    for (const row of answerRows) {
      addAnswerToAgg(questionAgg, row.question_id, String(row.question_text_snapshot ?? '').trim(), row.answer_value as AnswerValueKey, row.answer_score);
    }

    // Respostas das subperguntas → agrega por (subquestion_id + redação).
    const subAnswerRows = await getDb()
      .select({
        subquestion_id: feedbackSubquestionAnswers.subquestionId,
        subquestion_text_snapshot: feedbackSubquestionAnswers.subquestionTextSnapshot,
        answer_value: feedbackSubquestionAnswers.answerValue,
        answer_score: feedbackSubquestionAnswers.answerScore,
      })
      .from(feedbackSubquestionAnswers)
      .where(inArray(feedbackSubquestionAnswers.feedbackId, feedbackIds));

    const subAgg = new Map<string, QuestionAnswerAgg>();
    for (const row of subAnswerRows) {
      addAnswerToAgg(subAgg, row.subquestion_id, String(row.subquestion_text_snapshot ?? '').trim(), row.answer_value as AnswerValueKey, row.answer_score);
    }

    // Config ATUAL das perguntas (texto + is_active) por id — base da classificação
    // "atual" (ativa + texto igual ao configurado) vs "antiga" (editada/removida).
    // eq(enterprise_id) OBRIGATÓRIO no repo (o Drizzle ignora a RLS).
    const currentQ = new Map<string, { text: string; isActive: boolean }>();
    const questionIds = [...new Set([...questionAgg.values()].map((a) => a.id))];
    for (const def of await fetchQuestionDefsScoped(enterpriseId, questionIds)) {
      currentQ.set(def.id, { text: String(def.questionText ?? '').trim(), isActive: def.isActive === true });
    }

    // Config ATUAL das subperguntas (texto + is_active) + mapeamento subpergunta → pai.
    // O repo reforça o tenant via JOIN na pergunta-pai (enterprise_id).
    const subParentBySubId = new Map<string, string>();
    const currentSub = new Map<string, { text: string; isActive: boolean }>();
    const subIds = [...new Set([...subAgg.values()].map((a) => a.id))];
    for (const def of await fetchSubquestionDefsScoped(enterpriseId, subIds)) {
      subParentBySubId.set(def.id, def.questionId);
      currentSub.set(def.id, { text: String(def.subquestionText ?? '').trim(), isActive: def.isActive === true });
    }

    // Subperguntas agrupadas por pergunta-pai (todas as redações; cada uma com status).
    const subsByQuestion = new Map<string, ReturnType<typeof buildSubMetric>[]>();
    for (const agg of subAgg.values()) {
      const parentId = subParentBySubId.get(agg.id);
      if (!parentId) continue;
      const status = subMetricStatus(currentQ.get(parentId), currentSub.get(agg.id), agg.text);
      const list = subsByQuestion.get(parentId) ?? [];
      list.push(buildSubMetric(agg, status));
      subsByQuestion.set(parentId, list);
    }
    for (const list of subsByQuestion.values()) {
      list.sort((a, b) => a.mean - b.mean);
    }

    // Agrupa as entradas por question_id para eleger a redação que hospeda as
    // subperguntas (a redação "viva" — a que casa com o texto da config, seja
    // atual ou desativada; senão a primeira) — evita duplicar entre redações.
    const entriesByQid = new Map<string, QuestionAnswerAgg[]>();
    for (const agg of questionAgg.values()) {
      const list = entriesByQid.get(agg.id) ?? [];
      list.push(agg);
      entriesByQid.set(agg.id, list);
    }

    const questions = [...entriesByQid.entries()]
      .flatMap(([qid, aggs]) => {
        const cfg = currentQ.get(qid);
        const host = aggs.find((a) => cfg?.text === a.text) ?? aggs[0];
        return aggs.map((agg) => ({
          question_id: qid,
          text: agg.text,
          ...aggToMetricFields(agg),
          status: questionMetricStatus(cfg, agg.text),
          subquestions: agg === host ? (subsByQuestion.get(qid) ?? []) : [],
        }));
      })
      .sort((a, b) => a.mean - b.mean);

    return res.json({ questions });
  } catch (error) {
    console.error('Erro ao buscar métricas por pergunta:', error);
    return sendTypedError(res, 500, API_ERROR_INTERNAL_SERVER_ERROR);
  }
}

/** Estado da redação de uma pergunta vs a config atual (ver QuestionMetricStatus). */
function questionMetricStatus(cfg: ConfigEntry, snapshot: string): QuestionMetricStatus {
  if (cfg && cfg.text === snapshot) return cfg.isActive ? 'current' : 'deactivated';
  return 'past';
}

/** Estado de uma subpergunta: "atual" só com pai ativo + subpergunta ativa + texto atual. */
function subMetricStatus(
  parentCfg: ConfigEntry,
  subCfg: ConfigEntry,
  snapshot: string,
): QuestionMetricStatus {
  if (subCfg && subCfg.text === snapshot) {
    return parentCfg?.isActive === true && subCfg.isActive === true ? 'current' : 'deactivated';
  }
  return 'past';
}

function buildSubMetric(agg: QuestionAnswerAgg, status: QuestionMetricStatus) {
  return { subquestion_id: agg.id, text: agg.text, ...aggToMetricFields(agg), status };
}
