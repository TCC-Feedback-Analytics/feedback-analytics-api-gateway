import { and, count, eq, max, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { feedback, feedbackAnalysis } from '../../drizzle/schema.js';
import { scopedFeedbackWhere } from '../db/tenantScope.js';
import type { MetricsPeriod } from '../libs/period.js';
import type { CommentRatingRow } from '../libs/commentParticipation.js';

export interface ScopedStatsParams {
  enterpriseId: string;
  /** `null` = toda a empresa; `[]` = escopo sem pontos (zero resultados). */
  collectionPointIds: string[] | null;
  /** Recorte por data de criação do feedback (etapa 02); ausente = histórico inteiro. */
  period?: MetricsPeriod | null;
}

export interface ScopedRatingAggregates {
  totalFeedbacks: number;
  ratingSum: number;
  ratingDistribution: { 1: number; 2: number; 3: number; 4: number; 5: number };
}

export interface ScopedAnalysisAggregates {
  totalAnalyzed: number;
  latestAnalysisAt: string | null;
  aiCounts: { positive: number; neutral: number; negative: number };
}

function emptyDistribution(): ScopedRatingAggregates['ratingDistribution'] {
  return { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
}

/** Escopo válido porém sem nenhum ponto de coleta => não há o que agregar. */
function scopeHasNoPoints(ids: string[] | null): boolean {
  return Array.isArray(ids) && ids.length === 0;
}

/**
 * Distribuição de notas (1..5), total e soma — agregados NO BANCO via
 * `GROUP BY rating` (Drizzle), em vez de somar linha a linha em JavaScript.
 * Sempre filtrado por `enterprise_id` (+ escopo opcional) pelo helper único.
 */
export async function fetchScopedRatingAggregates(
  params: ScopedStatsParams,
): Promise<ScopedRatingAggregates> {
  const { enterpriseId, collectionPointIds, period } = params;

  if (scopeHasNoPoints(collectionPointIds)) {
    return { totalFeedbacks: 0, ratingSum: 0, ratingDistribution: emptyDistribution() };
  }

  const rows = await getDb()
    .select({ rating: feedback.rating, c: count() })
    .from(feedback)
    .where(scopedFeedbackWhere(enterpriseId, collectionPointIds, period))
    .groupBy(feedback.rating);

  const ratingDistribution = emptyDistribution();
  let totalFeedbacks = 0;
  let ratingSum = 0;

  for (const row of rows) {
    const c = Number(row.c);
    totalFeedbacks += c;

    const rating = row.rating;
    if (rating != null) {
      ratingSum += rating * c;
      if (rating >= 1 && rating <= 5) {
        ratingDistribution[rating as 1 | 2 | 3 | 4 | 5] = c;
      }
    }
  }

  return { totalFeedbacks, ratingSum, ratingDistribution };
}

/**
 * Agregados da análise de IA sobre o subconjunto analisado do escopo: quantos
 * feedbacks já têm análise (`feedback_analysis` é 1:1 com `feedback`), a análise
 * mais recente, e a contagem por sentimento — via `GROUP BY sentiment` num JOIN
 * `feedback_analysis × feedback`, sempre filtrado por `enterprise_id` (+ escopo).
 */
export async function fetchScopedAnalysisAggregates(
  params: ScopedStatsParams,
): Promise<ScopedAnalysisAggregates> {
  const { enterpriseId, collectionPointIds, period } = params;

  if (scopeHasNoPoints(collectionPointIds)) {
    return { totalAnalyzed: 0, latestAnalysisAt: null, aiCounts: { positive: 0, neutral: 0, negative: 0 } };
  }

  const rows = await getDb()
    .select({
      sentiment: feedbackAnalysis.sentiment,
      c: count(),
      latest: max(feedbackAnalysis.createdAt),
    })
    .from(feedbackAnalysis)
    .innerJoin(feedback, eq(feedbackAnalysis.feedbackId, feedback.id))
    .where(scopedFeedbackWhere(enterpriseId, collectionPointIds, period))
    .groupBy(feedbackAnalysis.sentiment);

  let totalAnalyzed = 0;
  let latestAnalysisAt: string | null = null;
  const aiCounts = { positive: 0, neutral: 0, negative: 0 };

  for (const row of rows) {
    const c = Number(row.c);
    totalAnalyzed += c;

    if (row.latest && (latestAnalysisAt === null || row.latest > latestAnalysisAt)) {
      latestAnalysisAt = row.latest;
    }

    const sentiment = row.sentiment;
    if (sentiment === 'positive' || sentiment === 'neutral' || sentiment === 'negative') {
      aiCounts[sentiment] += c;
    }
  }

  return { totalAnalyzed, latestAnalysisAt, aiCounts };
}

/**
 * Estrelas agrupadas por "escreveu comentário ou não" (o comentário é opcional):
 * base da participação nos comentários e de quantos esperam pela análise da IA.
 */
export async function fetchScopedRatingByComment(params: ScopedStatsParams): Promise<CommentRatingRow[]> {
  const { enterpriseId, collectionPointIds, period } = params;
  if (scopeHasNoPoints(collectionPointIds)) return [];

  const hasComment = sql<boolean>`length(trim(${feedback.message})) > 0`;
  const rows = await getDb()
    .select({ hasComment, rating: feedback.rating, c: count() })
    .from(feedback)
    .where(scopedFeedbackWhere(enterpriseId, collectionPointIds, period))
    .groupBy(hasComment, feedback.rating);

  return rows.map((row) => ({ hasComment: row.hasComment === true, rating: row.rating, count: Number(row.c) }));
}

/**
 * Quantos feedbacks do escopo têm comentário escrito (texto não vazio). Base de
 * "comentários ainda não analisados" no diagnóstico do escopo.
 */
export async function fetchScopedCommentCount(params: ScopedStatsParams): Promise<number> {
  const { enterpriseId, collectionPointIds, period } = params;
  if (scopeHasNoPoints(collectionPointIds)) return 0;

  const [row] = await getDb()
    .select({ c: count() })
    .from(feedback)
    .where(and(scopedFeedbackWhere(enterpriseId, collectionPointIds, period), sql`length(trim(${feedback.message})) > 0`));

  return Number(row?.c ?? 0);
}
