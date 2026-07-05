import { and, eq, type SQL } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { feedback, feedbackAnalysis } from '../../drizzle/schema.js';
import { scopedFeedbackWhere } from '../db/tenantScope.js';

/**
 * Feedbacks ANALISADOS do escopo (INNER JOIN em `feedback_analysis`, 1:1 — só
 * retorna feedbacks com análise, igual ao antigo `normalizeFeedbackAnalysisRows`
 * que descartava os sem análise). Filtro opcional por sentimento. SEMPRE
 * tenant-scoped por `enterprise_id` (via scopedFeedbackWhere).
 *
 * Retorna no shape aninhado que o `normalizeFeedbackAnalysisRows` consome
 * (`{ id, message, rating, created_at, feedback_analysis: {...} }`).
 */
export async function fetchScopedFeedbackAnalysisRows(params: {
  enterpriseId: string;
  collectionPointIds: string[] | null;
  sentiment?: 'positive' | 'neutral' | 'negative';
}): Promise<Array<Record<string, unknown>>> {
  const { enterpriseId, collectionPointIds, sentiment } = params;

  const conds: SQL[] = [scopedFeedbackWhere(enterpriseId, collectionPointIds)];
  if (sentiment) conds.push(eq(feedbackAnalysis.sentiment, sentiment));

  const rows = await getDb()
    .select({
      id: feedback.id,
      message: feedback.message,
      rating: feedback.rating,
      createdAt: feedback.createdAt,
      sentiment: feedbackAnalysis.sentiment,
      categories: feedbackAnalysis.categories,
      keywords: feedbackAnalysis.keywords,
      aspects: feedbackAnalysis.aspects,
      sentimentScore: feedbackAnalysis.sentimentScore,
      confidence: feedbackAnalysis.confidence,
    })
    .from(feedback)
    .innerJoin(feedbackAnalysis, eq(feedbackAnalysis.feedbackId, feedback.id))
    .where(conds.length === 1 ? conds[0] : and(...conds));

  return rows.map((r) => ({
    id: r.id,
    message: r.message,
    rating: r.rating,
    created_at: r.createdAt,
    feedback_analysis: {
      sentiment: r.sentiment,
      categories: r.categories ?? [],
      keywords: r.keywords ?? [],
      aspects: r.aspects,
      // numeric → number (o PostgREST devolvia número; Drizzle devolve string).
      sentiment_score: r.sentimentScore != null ? Number(r.sentimentScore) : null,
      confidence: r.confidence != null ? Number(r.confidence) : null,
    },
  }));
}
