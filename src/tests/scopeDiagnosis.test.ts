import { describe, it, expect } from 'vitest';
import {
  diagnosisDataHash,
  movementBucketFor,
  parseScopeDiagnosisResponse,
  previousPeriodOf,
  selectCommentSamples,
  toDiagnosisMetrics,
  type ScopeMetricsSnapshot,
} from '../libs/scopeDiagnosis.js';
import type { ScopedAnalysis } from '../services/scopeMetrics.service.js';

type Item = ScopedAnalysis['items'][number];

function item(id: string, overrides: Partial<Item> = {}): Item {
  return {
    id, message: `Comentário ${id}`, rating: 4, created_at: '2026-09-02T10:00:00.000Z', sentiment: 'positive',
    categories: [], keywords: [], discrepancy: null, aspects: [], sentiment_score: 0.5, confidence: 0.9,
    ...overrides,
  } as Item;
}

function analysisOf(items: Item[], aspectSentiments: Array<{ aspect: string; count: number; netSentimentScore: number }> = []): ScopedAnalysis {
  return {
    items,
    summary: {
      totalAnalyzed: items.length,
      sentiments: { positive: items.filter((i) => i.sentiment === 'positive').length, neutral: 0, negative: items.filter((i) => i.sentiment === 'negative').length },
      topCategories: [], topKeywords: [], netSentimentScore: 20, sentimentCIs: {} as never, confidenceTier: 'low',
      aspectSentiments: aspectSentiments.map((a) => ({ ...a, positive: 0, neutral: 0, negative: 0, ci: { lower: 0, upper: 0 } })),
    },
  } as ScopedAnalysis;
}

function snapshot(overrides: Partial<ScopeMetricsSnapshot> = {}): ScopeMetricsSnapshot {
  return {
    stats: {
      totalFeedbacks: 20, totalAnalyzed: 8, starMean: 4.1, starMeanCI: { lower: 3.8, upper: 4.4 },
      ratingDistribution: { 1: 1, 2: 1, 3: 2, 4: 6, 5: 10 }, netSatisfaction: 70, csat: { pct: 80, ci: { lower: 58, upper: 92 } },
      confidenceTier: 'low',
      commentParticipation: {
        total: 20, withComment: 12, pct: 60, ci: { lower: 39, upper: 78 }, confidenceTier: 'low',
        withCommentRating: { n: 12, mean: 3.6, ci: { lower: 3, upper: 4.2 } }, withoutCommentRating: { n: 8, mean: 4.8, ci: { lower: 4.4, upper: 5 } },
      },
    } as ScopeMetricsSnapshot['stats'],
    analysis: analysisOf([item('a', { discrepancy: 'silent_detractor', sentiment: 'negative' })]),
    questions: [
      { question_id: 'q1', text: 'Atendimento', status: 'current', count: 18, mean: 3.2, ci: { lower: 2.8, upper: 3.6 },
        satisfiedPct: 40, confidenceTier: 'low', distribution: {} as never,
        ratingWeight: { r: 0.6, ci: { lower: 0.2, upper: 0.83 }, n: 18 },
        subquestions: [{ subquestion_id: 's1', text: 'Cordialidade', status: 'past', count: 3, mean: 2, ci: { lower: 1, upper: 3 }, satisfiedPct: 0, distribution: {} as never, confidenceTier: 'insufficient' }] },
      { question_id: 'q0', text: 'Pergunta antiga', status: 'past', count: 5, mean: 2, ci: { lower: 1, upper: 3 },
        satisfiedPct: 0, confidenceTier: 'insufficient', distribution: {} as never, ratingWeight: null, subquestions: [] },
    ] as ScopeMetricsSnapshot['questions'],
    withComment: 12,
    movement: { bucket: 'day', points: [{ start: '2026-09-01', count: 3, mean: 4 }] },
    heatmap: [{ weekday: 1, band: 2, count: 4, mean: 4.5 }, { weekday: 2, band: 0, count: 0, mean: null }],
    customers: {
      identified: 15, unidentified: 5, firstTimeCount: 12, returningCount: 3, returningPct: 20, returningPctCI: { lower: 7, upper: 45 },
      customers: 12, returningCustomers: 2, firstTime: { n: 12, mean: 4, ci: { lower: 3.5, upper: 4.5 } }, returning: { n: 3, mean: 4.7, ci: { lower: 4, upper: 5 } },
    },
    ...overrides,
  };
}

describe('diagnóstico do escopo — período anterior e intervalo do movimento', () => {
  it('período anterior tem o mesmo tamanho e termina onde o escolhido começa', () => {
    expect(previousPeriodOf({ start: '2026-09-01T03:00:00.000Z', end: '2026-10-01T03:00:00.000Z' }))
      .toEqual({ start: '2026-08-02T03:00:00.000Z', end: '2026-09-01T03:00:00.000Z' });
  });

  it('sem início ou fim, não há período anterior', () => {
    expect(previousPeriodOf({ start: null, end: null })).toBeNull();
    expect(previousPeriodOf({ start: '2026-09-01T03:00:00.000Z', end: null })).toBeNull();
  });

  it('dia até um mês, semana até três meses, mês acima ou em todo o período', () => {
    expect(movementBucketFor({ start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' })).toBe('day');
    expect(movementBucketFor({ start: '2026-07-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' })).toBe('week');
    expect(movementBucketFor({ start: '2026-01-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' })).toBe('month');
    expect(movementBucketFor({ start: null, end: null })).toBe('month');
  });
});

describe('diagnóstico do escopo — números de um período', () => {
  it('leva contagens, estrelas, só as perguntas atuais, pico com avaliações e clientes', () => {
    const metrics = toDiagnosisMetrics(snapshot());

    expect(metrics.counts).toEqual({ total: 20, with_comment: 12, analyzed: 8, pending_analysis: 4 });
    expect(metrics.ratings).toMatchObject({ mean: 4.1, net_satisfaction: 70, csat_pct: 80, confidence: 'low' });
    expect(metrics.questions.map((q) => q.question_id)).toEqual(['q1']);
    expect(metrics.questions[0]).toMatchObject({ satisfied_pct: 40, rating_weight: { r: 0.6, n: 18 }, subquestions: [] });
    expect(metrics.comments).toMatchObject({ net_sentiment_score: 20, silent_detractors: 1, rating_misuse: 0 });
    expect(metrics.peak_times).toEqual([{ weekday: 1, band: 2, count: 4, mean: 4.5 }]);
    expect(metrics.comment_participation).toEqual({ pct: 60, with_comment_mean: 3.6, without_comment_mean: 4.8 });
    expect(metrics.customers).toEqual({ identified: 15, returning_pct: 20, returning_pct_ci: { lower: 7, upper: 45 }, first_time_mean: 4, returning_mean: 4.7 });
  });

  it('blocos sem dados vêm nulos', () => {
    const metrics = toDiagnosisMetrics(snapshot({
      stats: { ...snapshot().stats, totalFeedbacks: 0, totalAnalyzed: 0 },
      analysis: { items: [], summary: { totalAnalyzed: 0, sentiments: { positive: 0, neutral: 0, negative: 0 }, topCategories: [], topKeywords: [] } },
      withComment: 0,
      movement: { bucket: 'day', points: [{ start: '2026-09-01', count: 0, mean: null }] },
      customers: { ...snapshot().customers, identified: 0 },
    }));
    expect(metrics.ratings).toBeNull();
    expect(metrics.comments).toBeNull();
    expect(metrics.movement).toBeNull();
    expect(metrics.customers).toBeNull();
  });
});

describe('diagnóstico do escopo — amostra de comentários', () => {
  it('pega os mais negativos primeiro, sem repetir, e um por assunto', () => {
    const items = [
      item('n1', { sentiment: 'negative', sentiment_score: -0.2, rating: 2 }),
      item('n2', { sentiment: 'negative', sentiment_score: -0.9, rating: 1 }),
      item('p1', { sentiment: 'positive', sentiment_score: 0.9 }),
      item('sd', { sentiment: 'negative', sentiment_score: -0.4, rating: 5, discrepancy: 'silent_detractor' }),
      item('asp', { sentiment: 'neutral', aspects: [{ aspect: 'Entrega', sentiment: 'neutral' }] as never }),
      item('vazio', { message: '   ', sentiment: 'negative', sentiment_score: -1 }),
    ];
    const samples = selectCommentSamples(analysisOf(items, [{ aspect: 'entrega', count: 4, netSentimentScore: -50 }]));

    expect(samples.map((s) => [s.id, s.reason])).toEqual([
      ['n2', 'most_negative'], ['sd', 'most_negative'], ['n1', 'most_negative'], ['p1', 'most_positive'], ['asp', 'aspect'],
    ]);
    expect(samples.find((s) => s.id === 'asp')?.aspect).toBe('entrega');
  });

  it('corta o texto em 500 caracteres e respeita as cotas', () => {
    const items = Array.from({ length: 20 }, (_, i) => item(`n${i}`, { sentiment: 'negative', sentiment_score: -i / 20, message: 'x'.repeat(800) }));
    const samples = selectCommentSamples(analysisOf(items));
    expect(samples).toHaveLength(6);
    expect(samples.every((s) => s.message.length === 500)).toBe(true);
  });
});

describe('diagnóstico do escopo — hash e resposta', () => {
  it('o mesmo pacote dá o mesmo hash; dados diferentes, hash diferente', () => {
    const request = { scope: { scope_type: 'COMPANY' }, current: { counts: { total: 10 } } } as never;
    const other = { scope: { scope_type: 'COMPANY' }, current: { counts: { total: 11 } } } as never;
    expect(diagnosisDataHash(request)).toBe(diagnosisDataHash(structuredClone(request)));
    expect(diagnosisDataHash(request)).not.toBe(diagnosisDataHash(other));
  });

  it('aceita a resposta no formato do contrato e recusa o resto', () => {
    const valid = {
      summary: 'Resumo.', going_well: [], concerns: [{ text: 'Atendimento.', evidence: 'Nota 3,2.' }], changes: [],
      recommendations: [{ priority: 1, kind: 'fix', action: 'Treinar a equipe.', evidence: 'Nota 3,2.' }], limitations: [],
    };
    expect(parseScopeDiagnosisResponse(valid)).toEqual(valid);
    expect(() => parseScopeDiagnosisResponse({ ...valid, recommendations: [] })).toThrow(expect.objectContaining({ code: 'invalid_ai_response_schema' }));
    expect(() => parseScopeDiagnosisResponse({ ...valid, concerns: [{ text: 'Sem evidência.' }] })).toThrow(expect.objectContaining({ code: 'invalid_ai_response_schema' }));
  });
});
