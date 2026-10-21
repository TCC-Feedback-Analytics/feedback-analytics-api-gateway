/**
 * Diagnóstico do escopo com IA: funções puras que montam o pacote enviado ao
 * ia-analyze a partir das métricas do escopo (as mesmas das telas), escolhem a
 * amostra de comentários e conferem a resposta. A matemática fica aqui; a IA
 * só interpreta.
 */
import { createHash } from 'node:crypto';
import type {
  ScopeDiagnosisCommentSample,
  ScopeDiagnosisMetrics,
  ScopeDiagnosisPeriod,
  ScopeDiagnosisRemoteRequest,
  ScopeDiagnosisResult,
  ScopeDiagnosisSampleReason,
} from '@feedback/lib-shared/interfaces/contracts/ia-analyze/scope-diagnosis.contract';
import type { MetricsPeriod } from './period.js';
import type { TimelineBucket, TimelinePoint } from './timeline.js';
import type { HeatmapCell } from './heatmap.js';
import type { CustomersSummary } from './customers.js';
import type { ScopedAnalysis, ScopedStats } from '../services/scopeMetrics.service.js';
import type { QuestionMetric } from '../services/questionMetrics.service.js';
import { IaAnalyzeServiceError } from './iaAnalyze/errors.js';

const DAY_MS = 86_400_000;
const MAX_SAMPLE_CHARS = 500;
const MAX_TOP_ASPECTS = 6;

/** Quantos comentários entram em cada motivo da amostra (no máximo 20 no total). */
const SAMPLE_QUOTAS: Array<[Exclude<ScopeDiagnosisSampleReason, 'aspect'>, number]> = [
  ['most_negative', 6],
  ['most_positive', 4],
  ['silent_detractor', 4],
  ['rating_misuse', 2],
];
const ASPECT_SAMPLES = 4;

/**
 * Período anterior de mesmo tamanho, logo antes do escolhido. Só existe com
 * início e fim: "todo o período" (ou um lado aberto) não tem com o que comparar.
 */
export function previousPeriodOf(period: MetricsPeriod): MetricsPeriod | null {
  if (!period.start || !period.end) return null;
  const start = Date.parse(period.start);
  const end = Date.parse(period.end);
  if (!(end > start)) return null;
  return { start: new Date(start - (end - start)).toISOString(), end: new Date(start).toISOString() };
}

/** Intervalo do movimento pelo tamanho do período: dia até ~1 mês, semana até ~3 meses, mês acima. */
export function movementBucketFor(period: MetricsPeriod): TimelineBucket {
  if (!period.start || !period.end) return 'month';
  const days = (Date.parse(period.end) - Date.parse(period.start)) / DAY_MS;
  if (days <= 31) return 'day';
  if (days <= 92) return 'week';
  return 'month';
}

export type ScopeMetricsSnapshot = {
  stats: ScopedStats;
  analysis: ScopedAnalysis;
  questions: QuestionMetric[];
  withComment: number;
  movement: { bucket: TimelineBucket; points: TimelinePoint[] } | null;
  heatmap: HeatmapCell[];
  customers: CustomersSummary;
};

/** Converte as métricas das telas no bloco de números de um período. */
export function toDiagnosisMetrics(snapshot: ScopeMetricsSnapshot): ScopeDiagnosisMetrics {
  const { stats, analysis, questions, customers } = snapshot;
  const items = analysis.items;
  const summary = analysis.summary;
  const analyzed = summary.totalAnalyzed;

  return {
    counts: {
      total: stats.totalFeedbacks,
      with_comment: snapshot.withComment,
      analyzed: stats.totalAnalyzed,
      pending_analysis: Math.max(0, snapshot.withComment - stats.totalAnalyzed),
    },
    ratings: stats.totalFeedbacks > 0
      ? {
          mean: stats.starMean,
          ci: stats.starMeanCI,
          distribution: stats.ratingDistribution,
          net_satisfaction: stats.netSatisfaction,
          csat_pct: stats.csat.pct,
          confidence: stats.confidenceTier,
        }
      : null,
    // Só as perguntas atuais do formulário: as antigas não dizem o que fazer agora.
    questions: questions
      .filter((question) => question.status === 'current' && question.count > 0)
      .map((question) => ({
        question_id: question.question_id,
        text: question.text,
        mean: question.mean,
        ci: question.ci,
        satisfied_pct: question.satisfiedPct,
        count: question.count,
        confidence: question.confidenceTier,
        rating_weight: question.ratingWeight
          ? { r: question.ratingWeight.r, ci: question.ratingWeight.ci, n: question.ratingWeight.n }
          : null,
        subquestions: question.subquestions
          .filter((sub) => sub.status === 'current' && sub.count > 0)
          .map((sub) => ({
            subquestion_id: sub.subquestion_id,
            text: sub.text,
            mean: sub.mean,
            count: sub.count,
            confidence: sub.confidenceTier,
          })),
      })),
    comments: analyzed > 0 && 'netSentimentScore' in summary
      ? {
          sentiments: summary.sentiments,
          net_sentiment_score: summary.netSentimentScore,
          confidence: summary.confidenceTier,
          top_aspects: summary.aspectSentiments.slice(0, MAX_TOP_ASPECTS).map((aspect) => ({
            aspect: aspect.aspect,
            count: aspect.count,
            net_sentiment_score: aspect.netSentimentScore,
          })),
          silent_detractors: items.filter((item) => item.discrepancy === 'silent_detractor').length,
          rating_misuse: items.filter((item) => item.discrepancy === 'rating_misuse').length,
        }
      : null,
    movement: snapshot.movement && snapshot.movement.points.some((point) => point.count > 0)
      ? { bucket: snapshot.movement.bucket, points: snapshot.movement.points }
      : null,
    peak_times: snapshot.heatmap
      .filter((cell) => cell.count > 0)
      .map((cell) => ({ weekday: cell.weekday, band: cell.band, count: cell.count, mean: cell.mean })),
    comment_participation: stats.commentParticipation && stats.commentParticipation.total > 0
      ? {
          pct: stats.commentParticipation.pct,
          with_comment_mean: stats.commentParticipation.withCommentRating?.mean ?? null,
          without_comment_mean: stats.commentParticipation.withoutCommentRating?.mean ?? null,
        }
      : null,
    customers: customers.identified > 0
      ? {
          identified: customers.identified,
          returning_pct: customers.returningPct,
          returning_pct_ci: customers.returningPctCI,
          first_time_mean: customers.firstTime?.mean ?? null,
          returning_mean: customers.returning?.mean ?? null,
        }
      : null,
  };
}

type AnalysisItem = ScopedAnalysis['items'][number];

function score(item: AnalysisItem): number {
  return typeof item.sentiment_score === 'number' ? item.sentiment_score : item.sentiment === 'negative' ? -0.5 : 0.5;
}

/**
 * Amostra de comentários para a IA ler o tom com as próprias palavras dos
 * clientes: os mais negativos e os mais positivos, as divergências entre nota e
 * texto e um por assunto principal. Sem repetir, com o texto cortado no limite.
 */
export function selectCommentSamples(analysis: ScopedAnalysis): ScopeDiagnosisCommentSample[] {
  const items = analysis.items.filter((item) => item.message.trim().length > 0);
  const chosen = new Map<string, ScopeDiagnosisCommentSample>();
  const take = (item: AnalysisItem, reason: ScopeDiagnosisSampleReason, aspect?: string) => {
    if (chosen.has(item.id)) return false;
    chosen.set(item.id, {
      id: item.id,
      message: item.message.trim().slice(0, MAX_SAMPLE_CHARS),
      rating: item.rating,
      sentiment: item.sentiment,
      reason,
      ...(aspect ? { aspect } : {}),
    });
    return true;
  };

  const pools: Record<Exclude<ScopeDiagnosisSampleReason, 'aspect'>, AnalysisItem[]> = {
    most_negative: items.filter((item) => item.sentiment === 'negative').sort((a, b) => score(a) - score(b)),
    most_positive: items.filter((item) => item.sentiment === 'positive').sort((a, b) => score(b) - score(a)),
    silent_detractor: items.filter((item) => item.discrepancy === 'silent_detractor'),
    rating_misuse: items.filter((item) => item.discrepancy === 'rating_misuse'),
  };
  for (const [reason, quota] of SAMPLE_QUOTAS) {
    let taken = 0;
    for (const item of pools[reason]) {
      if (taken >= quota) break;
      if (take(item, reason)) taken += 1;
    }
  }

  const aspects = 'aspectSentiments' in analysis.summary ? analysis.summary.aspectSentiments : [];
  for (const aspect of aspects.slice(0, ASPECT_SAMPLES)) {
    const match = items.find((item) => !chosen.has(item.id)
      && item.aspects.some((mention) => mention.aspect.trim().toLowerCase() === aspect.aspect));
    if (match) take(match, 'aspect', aspect.aspect);
  }

  return [...chosen.values()];
}

export function toDiagnosisPeriod(period: MetricsPeriod): ScopeDiagnosisPeriod {
  return { start: period.start, end: period.end };
}

/** Hash estável do pacote: mesmo recorte com os mesmos dados = mesmo diagnóstico guardado. */
export function diagnosisDataHash(request: ScopeDiagnosisRemoteRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const isFindingList = (value: unknown) => Array.isArray(value) && value.every((item) =>
  isObject(item) && typeof item.text === 'string' && typeof item.evidence === 'string');

/** Confere o formato que o ia-analyze devolve antes de guardar (ele já valida o conteúdo). */
export function parseScopeDiagnosisResponse(payload: unknown): ScopeDiagnosisResult {
  const invalid = (): never => {
    throw new IaAnalyzeServiceError('invalid_ai_response_schema', 502, 'invalid_ai_response_schema');
  };
  if (!isObject(payload) || typeof payload.summary !== 'string' || !payload.summary.trim()) return invalid();
  if (!isFindingList(payload.going_well) || !isFindingList(payload.concerns) || !isFindingList(payload.changes)) return invalid();
  if (!Array.isArray(payload.limitations) || !payload.limitations.every((item) => typeof item === 'string')) return invalid();
  if (!Array.isArray(payload.recommendations) || payload.recommendations.length === 0
    || !payload.recommendations.every((item) => isObject(item) && typeof item.priority === 'number'
      && (item.kind === 'fix' || item.kind === 'keep')
      && typeof item.action === 'string' && typeof item.evidence === 'string')) return invalid();
  return payload as unknown as ScopeDiagnosisResult;
}
