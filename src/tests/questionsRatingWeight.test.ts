import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../index.js';
import { resolveEnterpriseIdByUser } from '../repositories/enterprise.repository.js';
import { fetchQuestionDefsScoped, fetchSubquestionDefsScoped } from '../repositories/feedbackQuestions.repository.js';

const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';
const TEST_ENTERPRISE_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

// O controller lê o banco em três consultas, nesta ordem: feedbacks do escopo,
// respostas das perguntas e respostas das subperguntas. O banco fica simulado.
const { dbResults } = vi.hoisted(() => ({ dbResults: [] as unknown[][] }));
vi.mock('../db/client.js', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(dbResults.shift() ?? []),
      }),
    }),
  }),
  closeDb: vi.fn(),
}));
vi.mock('../middlewares/auth.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: TEST_USER_ID };
    next();
  },
}));
vi.mock('../repositories/enterprise.repository.js', () => ({ resolveEnterpriseIdByUser: vi.fn() }));
vi.mock('../repositories/feedbackQuestions.repository.js', () => ({
  fetchQuestionDefsScoped: vi.fn(),
  fetchSubquestionDefsScoped: vi.fn(),
}));

const answer = (feedbackId: string, questionId: string, text: string, score: number) => ({
  feedback_id: feedbackId,
  question_id: questionId,
  question_text_snapshot: text,
  answer_value: ['PESSIMO', 'RUIM', 'MEDIANA', 'BOA', 'OTIMA'][score - 1],
  answer_score: score,
});

describe('[Integração] GET /feedbacks/questions — o que mais pesa na nota', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbResults.length = 0;
    vi.mocked(resolveEnterpriseIdByUser).mockResolvedValue(TEST_ENTERPRISE_ID);
    vi.mocked(fetchQuestionDefsScoped).mockResolvedValue([
      { id: 'q-espera', questionText: 'Tempo de espera', isActive: true },
      { id: 'q-cardapio', questionText: 'Cardápio', isActive: true },
    ] as never);
    vi.mocked(fetchSubquestionDefsScoped).mockResolvedValue([]);
  });

  it('cruza a nota de cada pergunta com as estrelas do mesmo feedback', async () => {
    const stars = [1, 2, 3, 4, 5, 5];
    const feedbacks = stars.map((rating, index) => ({ id: `f${index}`, rating }));
    dbResults.push(
      feedbacks,
      [
        // Tempo de espera acompanha as estrelas; o cardápio vai no sentido contrário.
        ...feedbacks.map((f) => answer(f.id, 'q-espera', 'Tempo de espera', f.rating)),
        ...feedbacks.map((f) => answer(f.id, 'q-cardapio', 'Cardápio', 6 - f.rating)),
      ],
      [],
    );

    const res = await request(app).get('/api/protected/user/feedbacks/questions');

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.questions.map((q: { question_id: string }) => [q.question_id, q]));
    expect(byId['q-espera'].ratingWeight).toMatchObject({ r: 1, n: 6 });
    expect(byId['q-cardapio'].ratingWeight).toMatchObject({ r: -1, n: 6 });
    expect(byId['q-espera'].ratingWeight.ci.lower).toBeLessThanOrEqual(1);
  });

  it('com poucos pares, ratingWeight vem nulo', async () => {
    dbResults.push([{ id: 'f1', rating: 5 }], [answer('f1', 'q-espera', 'Tempo de espera', 5)], []);

    const res = await request(app).get('/api/protected/user/feedbacks/questions');

    expect(res.status).toBe(200);
    expect(res.body.questions[0].ratingWeight).toBeNull();
  });
});
