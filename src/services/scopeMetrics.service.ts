import { normalizeFeedbackAnalysisRows } from '../libs/iaAnalyze/normalize.js';
import type { MetricsPeriod } from '../libs/period.js';
import {
  ratingStats,
  csatTopTwoBox,
  netSatisfaction,
  netSentimentScore,
  confidenceTier,
  wilsonInterval,
  wilsonLowerBound,
} from '../libs/statistics/index.js';
import { fillTimeline, localDateOf, type TimelineBucket, type TimelinePoint } from '../libs/timeline.js';
import { fillHeatmap, type HeatmapCell } from '../libs/heatmap.js';
import { summarizeCustomers, type CustomersSummary } from '../libs/customers.js';
import {
  fetchScopedRatingAggregates,
  fetchScopedAnalysisAggregates,
} from '../repositories/feedbackStats.repository.js';
import { fetchScopedFeedbackAnalysisRows } from '../repositories/feedbackAnalysis.repository.js';
import { fetchScopedTimeline } from '../repositories/feedbackTimeline.repository.js';
import { fetchScopedHeatmap } from '../repositories/feedbackHeatmap.repository.js';
import { fetchScopedCustomerVisits } from '../repositories/feedbackCustomers.repository.js';

/**
 * Métricas do escopo no período, fora dos controllers: as telas (via
 * `/feedbacks/*`) e o diagnóstico do escopo leem exatamente os mesmos números.
 */
export type ScopeMetricsParams = {
  enterpriseId: string;
  /** `null` = sem filtro de escopo; `[]` = escopo sem pontos de coleta. */
  collectionPointIds: string[] | null;
  period: MetricsPeriod;
};

/** Lentes satisfação (estrelas) e sentimento (texto analisado pela IA). Base de `/feedbacks/stats`. */
export async function computeScopedStats(params: ScopeMetricsParams) {
  // Agregações servidas via DRIZZLE, com a contagem feita NO BANCO (GROUP BY),
  // e SEMPRE com filtro explícito por enterprise_id (isolamento multi-tenant na
  // aplicação — o Drizzle acessa com role que ignora a RLS). Ver
  // src/db/tenantScope.ts e src/repositories/feedbackStats.repository.ts.
  const ratingAgg = await fetchScopedRatingAggregates(params);
  const analysisAgg = await fetchScopedAnalysisAggregates(params);

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

  return {
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
  };
}

export type ScopedStats = Awaited<ReturnType<typeof computeScopedStats>>;

/** Comentários analisados pela IA (itens + resumo ranqueado). Base de `/feedbacks/analysis`. */
export async function computeScopedAnalysis(
  params: ScopeMetricsParams & { sentiment?: 'positive' | 'neutral' | 'negative' },
) {
  const emptyResult = {
    items: [],
    summary: { totalAnalyzed: 0, sentiments: { positive: 0, neutral: 0, negative: 0 }, topCategories: [], topKeywords: [] },
  };

  if (params.collectionPointIds && params.collectionPointIds.length === 0) {
    return emptyResult;
  }

  const data = await fetchScopedFeedbackAnalysisRows(params);

  const itemsRaw = normalizeFeedbackAnalysisRows(data);
  if (itemsRaw.length === 0) return emptyResult;

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

  return {
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
  };
}

export type ScopedAnalysis = Awaited<ReturnType<typeof computeScopedAnalysis>>;

/**
 * Movimento no tempo: intervalos contínuos do início do período (ou da primeira
 * avaliação) até o fim do período (ou hoje), no fuso do gestor. `null` se passar
 * do teto de pontos. Base de `/feedbacks/timeline`.
 */
export async function computeScopedTimeline(
  params: ScopeMetricsParams & { bucket: TimelineBucket; timeZone: string; now?: Date },
): Promise<TimelinePoint[] | null> {
  const { period, bucket, timeZone } = params;
  const rows = await fetchScopedTimeline(params);

  const today = localDateOf(params.now ?? new Date(), timeZone);
  const toDate = period.end ? localDateOf(new Date(Date.parse(period.end) - 1), timeZone) : today;
  const fromDate = period.start ? localDateOf(new Date(period.start), timeZone) : rows[0]?.start ?? toDate;

  return fillTimeline(rows, { fromDate, toDate, bucket });
}

/** Dias e horários de pico: sempre as 28 células. Base de `/feedbacks/heatmap`. */
export async function computeScopedHeatmap(params: ScopeMetricsParams & { timeZone: string }): Promise<HeatmapCell[]> {
  return fillHeatmap(await fetchScopedHeatmap(params));
}

/** Clientes que voltam (aparelho identificado). Base de `/feedbacks/customers`. */
export async function computeScopedCustomers(params: ScopeMetricsParams): Promise<CustomersSummary> {
  const { rows, customers, returningCustomers } = await fetchScopedCustomerVisits(params);
  return summarizeCustomers(rows, { customers, returningCustomers });
}
