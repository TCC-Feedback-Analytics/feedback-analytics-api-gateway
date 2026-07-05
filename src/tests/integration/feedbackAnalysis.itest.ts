import { describe, it, expect, afterAll } from 'vitest';
import { fetchScopedFeedbackAnalysisRows } from '../../repositories/feedbackAnalysis.repository.js';
import { closeDb } from '../../db/client.js';

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000001';

afterAll(async () => {
  await closeDb();
});

type Row = { feedback_analysis: { sentiment: string; categories: string[]; sentiment_score: number | null } };

describe('[Integração] fetchScopedFeedbackAnalysisRows — sentimento + isolamento', () => {
  it('A: 3 analisados (2 positive, 1 negative — só os que têm análise)', async () => {
    const rows = await fetchScopedFeedbackAnalysisRows({ enterpriseId: A, collectionPointIds: null });
    expect(rows).toHaveLength(3);
    const first = rows[0] as unknown as Row;
    expect(typeof first.feedback_analysis.sentiment).toBe('string');
    expect(Array.isArray(first.feedback_analysis.categories)).toBe(true);
    // numeric convertido para número
    expect(typeof first.feedback_analysis.sentiment_score).toBe('number');
  });

  it('filtro de sentimento: positive=2, negative=1, neutral=0', async () => {
    expect(await fetchScopedFeedbackAnalysisRows({ enterpriseId: A, collectionPointIds: null, sentiment: 'positive' })).toHaveLength(2);
    expect(await fetchScopedFeedbackAnalysisRows({ enterpriseId: A, collectionPointIds: null, sentiment: 'negative' })).toHaveLength(1);
    expect(await fetchScopedFeedbackAnalysisRows({ enterpriseId: A, collectionPointIds: null, sentiment: 'neutral' })).toHaveLength(0);
  });

  it('ISOLAMENTO: B não tem análises e não enxerga as de A', async () => {
    expect(await fetchScopedFeedbackAnalysisRows({ enterpriseId: B, collectionPointIds: null })).toHaveLength(0);
    expect(await fetchScopedFeedbackAnalysisRows({ enterpriseId: B, collectionPointIds: null, sentiment: 'positive' })).toHaveLength(0);
  });
});
