import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  computeScopedAnalysis,
  computeScopedCustomers,
  computeScopedStats,
  computeScopedTimeline,
} from '../services/scopeMetrics.service.js';
import { computeScopedQuestionMetrics } from '../services/questionMetrics.service.js';
import {
  fetchScopedRatingAggregates,
  fetchScopedAnalysisAggregates,
  fetchScopedRatingByComment,
} from '../repositories/feedbackStats.repository.js';
import { fetchScopedFeedbackAnalysisRows } from '../repositories/feedbackAnalysis.repository.js';
import { fetchScopedTimeline } from '../repositories/feedbackTimeline.repository.js';
import { fetchScopedCustomerVisits } from '../repositories/feedbackCustomers.repository.js';

// As telas e o diagnóstico do escopo leem os mesmos serviços: aqui eles rodam
// direto, sem rota, com os repositórios simulados.
const { getDb } = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock('../db/client.js', () => ({ getDb, closeDb: vi.fn() }));
vi.mock('../repositories/feedbackStats.repository.js', () => ({
  fetchScopedRatingAggregates: vi.fn(),
  fetchScopedAnalysisAggregates: vi.fn(),
  fetchScopedRatingByComment: vi.fn(),
}));
vi.mock('../repositories/feedbackAnalysis.repository.js', () => ({ fetchScopedFeedbackAnalysisRows: vi.fn() }));
vi.mock('../repositories/commentField.repository.js', () => ({
  fetchScopeCommentField: vi.fn(async () => ({ hidden: 'none', prompt: null })),
}));
vi.mock('../repositories/feedbackTimeline.repository.js', () => ({ fetchScopedTimeline: vi.fn() }));
vi.mock('../repositories/feedbackCustomers.repository.js', () => ({ fetchScopedCustomerVisits: vi.fn() }));
vi.mock('../repositories/feedbackQuestions.repository.js', () => ({
  fetchQuestionDefsScoped: vi.fn(),
  fetchSubquestionDefsScoped: vi.fn(),
}));

const ENTERPRISE_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const ALL_TIME = { start: null, end: null };
const SEPTEMBER = { start: '2026-09-01T03:00:00.000Z', end: '2026-10-01T03:00:00.000Z' };

describe('serviços de métricas do escopo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('estatísticas: estrelas e tom dos comentários, com o período repassado ao banco', async () => {
    vi.mocked(fetchScopedRatingAggregates).mockResolvedValue({
      totalFeedbacks: 10, ratingSum: 42, ratingDistribution: { 1: 0, 2: 1, 3: 1, 4: 3, 5: 5 },
    });
    vi.mocked(fetchScopedAnalysisAggregates).mockResolvedValue({
      totalAnalyzed: 4, latestAnalysisAt: '2026-09-20T12:00:00.000Z', aiCounts: { positive: 3, neutral: 0, negative: 1 },
    });
    // 10 avaliações, 7 com comentário e 4 analisadas: faltam 3 (sem comentário não espera a IA).
    vi.mocked(fetchScopedRatingByComment).mockResolvedValue([
      { hasComment: true, rating: 2, count: 1 },
      { hasComment: true, rating: 4, count: 2 },
      { hasComment: true, rating: 5, count: 4 },
      { hasComment: false, rating: 3, count: 1 },
      { hasComment: false, rating: 4, count: 1 },
      { hasComment: false, rating: 5, count: 1 },
    ]);

    const stats = await computeScopedStats({ enterpriseId: ENTERPRISE_ID, collectionPointIds: null, period: SEPTEMBER });

    expect(fetchScopedRatingAggregates).toHaveBeenCalledWith({ enterpriseId: ENTERPRISE_ID, collectionPointIds: null, period: SEPTEMBER });
    expect(stats.totalFeedbacks).toBe(10);
    expect(stats.averageRating).toBe(4.2);
    expect(stats.pendingCount).toBe(3);
    expect(stats.commentParticipation).toMatchObject({ total: 10, withComment: 7, pct: 70 });
    expect(stats.commentField).toEqual({ hidden: 'none', prompt: null });
    expect(stats.csat.pct).toBe(80);
    expect(stats.aiSentiment?.netSentimentScore).toBe(50);
  });

  it('análise: escopo sem pontos de coleta devolve vazio sem consultar o banco', async () => {
    const analysis = await computeScopedAnalysis({ enterpriseId: ENTERPRISE_ID, collectionPointIds: [], period: ALL_TIME });
    expect(analysis.items).toEqual([]);
    expect(analysis.summary.totalAnalyzed).toBe(0);
    expect(fetchScopedFeedbackAnalysisRows).not.toHaveBeenCalled();
  });

  it('análise: marca a divergência entre nota e comentário', async () => {
    vi.mocked(fetchScopedFeedbackAnalysisRows).mockResolvedValue([
      { id: 'f1', message: 'Demorou demais', rating: 5, created_at: '2026-09-02T10:00:00.000Z',
        feedback_analysis: { sentiment: 'negative', categories: ['espera'], keywords: ['demora'], aspects: [] } },
    ] as never);

    const analysis = await computeScopedAnalysis({ enterpriseId: ENTERPRISE_ID, collectionPointIds: null, period: ALL_TIME });

    expect(analysis.items[0].discrepancy).toBe('silent_detractor');
    expect(analysis.summary.sentiments).toEqual({ positive: 0, neutral: 0, negative: 1 });
  });

  it('perguntas: escopo sem pontos de coleta devolve lista vazia sem consultar o banco', async () => {
    expect(await computeScopedQuestionMetrics({ enterpriseId: ENTERPRISE_ID, collectionPointIds: [], period: ALL_TIME })).toEqual([]);
    expect(getDb).not.toHaveBeenCalled();
  });

  it('movimento: preenche do início ao fim do período, no fuso pedido', async () => {
    vi.mocked(fetchScopedTimeline).mockResolvedValue([{ start: '2026-09-10', count: 2, ratingCount: 2, ratingSum: 9 }]);

    const points = await computeScopedTimeline({
      enterpriseId: ENTERPRISE_ID, collectionPointIds: null, period: SEPTEMBER, bucket: 'day', timeZone: 'America/Sao_Paulo',
    });

    expect(points).toHaveLength(30);
    expect(points?.[0].start).toBe('2026-09-01');
    expect(points?.[29].start).toBe('2026-09-30');
    expect(points?.find((point) => point.start === '2026-09-10')?.mean).toBe(4.5);
  });

  it('movimento: sem período, vai da primeira avaliação até hoje', async () => {
    vi.mocked(fetchScopedTimeline).mockResolvedValue([{ start: '2026-10-15', count: 1, ratingCount: 1, ratingSum: 5 }]);

    const points = await computeScopedTimeline({
      enterpriseId: ENTERPRISE_ID, collectionPointIds: null, period: ALL_TIME, bucket: 'day', timeZone: 'America/Sao_Paulo',
      now: new Date('2026-10-20T15:00:00.000Z'),
    });

    expect(points?.map((point) => point.start)).toEqual(['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20']);
  });

  it('clientes: resume as visitas do repositório', async () => {
    vi.mocked(fetchScopedCustomerVisits).mockResolvedValue({
      rows: [
        { visit: 'first', rating: 4, count: 3 },
        { visit: 'returning', rating: 5, count: 1 },
      ],
      customers: 3,
      returningCustomers: 1,
    });

    const summary = await computeScopedCustomers({ enterpriseId: ENTERPRISE_ID, collectionPointIds: null, period: ALL_TIME });

    expect(summary.identified).toBe(4);
    expect(summary.returningCount).toBe(1);
    expect(summary.returningCustomers).toBe(1);
  });
});
