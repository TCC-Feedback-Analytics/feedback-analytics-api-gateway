import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../index.js';
import {
  fetchScopedRatingAggregates,
  fetchScopedAnalysisAggregates,
  fetchScopedRatingByComment,
} from '../repositories/feedbackStats.repository.js';
import { resolveEnterpriseIdByUser } from '../repositories/enterprise.repository.js';

const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';
const TEST_ENTERPRISE_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

// requireAuth mockado: o gating real (sessão Better Auth) é coberto pelo e2e.
// Cada teste controla o "usuário logado" via authState (ou null → 401).
const { authState } = vi.hoisted(() => ({
  authState: { user: null as { id: string; email?: string | null } | null },
}));
vi.mock('../middlewares/auth.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requireAuth: (req: any, res: any, next: any) => {
    if (!authState.user) return res.status(401).json({ error: 'unauthorized' });
    req.user = authState.user;
    next();
  },
}));

// As agregações de stats migraram para Drizzle; mockamos o repositório para
// testar o controller sem um banco real (a agregação real é coberta por integração).
vi.mock('../repositories/feedbackStats.repository.js', () => ({
  fetchScopedRatingAggregates: vi.fn(),
  fetchScopedAnalysisAggregates: vi.fn(),
  fetchScopedRatingByComment: vi.fn(async () => []),
  fetchScopedRatingByChannel: vi.fn(async () => []),
}));
vi.mock('../repositories/enterprise.repository.js', () => ({
  resolveEnterpriseIdByUser: vi.fn(),
}));
vi.mock('../repositories/commentField.repository.js', () => ({
  fetchScopeCommentField: vi.fn(async () => ({ hidden: 'none', prompt: null })),
}));

const mockRatingAgg = vi.mocked(fetchScopedRatingAggregates);
const mockAnalysisAgg = vi.mocked(fetchScopedAnalysisAggregates);
const mockRatingByComment = vi.mocked(fetchScopedRatingByComment);
const mockResolveEnterprise = vi.mocked(resolveEnterpriseIdByUser);

describe('[Integração] GET /api/protected/user/feedbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: TEST_USER_ID };
  });

  it('retorna 401 sem autenticação', async () => {
    authState.user = null;
    const res = await request(app).get('/api/protected/user/feedbacks');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('[CT-UC10-02] retorna 404 quando empresa não encontrada', async () => {
    mockResolveEnterprise.mockResolvedValueOnce(null);
    const res = await request(app).get('/api/protected/user/feedbacks');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('enterprise_not_found');
  });

  // Os casos de dados da lista migraram para integração (feedbackList.itest.ts).
});

describe('[Integração] GET /api/protected/user/feedbacks/stats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: TEST_USER_ID };
  });

  it('retorna 401 sem autenticação', async () => {
    authState.user = null;
    const res = await request(app).get('/api/protected/user/feedbacks/stats');
    expect(res.status).toBe(401);
  });

  it('[CT-UC09-01] retorna 200 com distribuição de ratings (agregação via Drizzle)', async () => {
    mockResolveEnterprise.mockResolvedValueOnce(TEST_ENTERPRISE_ID);
    mockRatingAgg.mockResolvedValueOnce({
      totalFeedbacks: 4,
      ratingSum: 17,
      ratingDistribution: { 1: 0, 2: 0, 3: 1, 4: 1, 5: 2 },
    });
    mockAnalysisAgg.mockResolvedValueOnce({
      totalAnalyzed: 0,
      latestAnalysisAt: null,
      aiCounts: { positive: 0, neutral: 0, negative: 0 },
    });
    // 4 avaliações, 3 com comentário: só essas 3 esperam pela IA (o comentário é opcional).
    mockRatingByComment.mockResolvedValueOnce([
      { hasComment: true, rating: 3, count: 1 },
      { hasComment: true, rating: 5, count: 2 },
      { hasComment: false, rating: 4, count: 1 },
    ]);

    const res = await request(app).get('/api/protected/user/feedbacks/stats');

    expect(res.status).toBe(200);
    expect(res.body.totalFeedbacks).toBe(4);
    expect(res.body.averageRating).toBe(4.3); // 17/4 = 4.25 → 4.3
    expect(res.body.ratingDistribution).toEqual({ 1: 0, 2: 0, 3: 1, 4: 1, 5: 2 });
    expect(res.body.pendingCount).toBe(3);
    expect(res.body.commentParticipation).toMatchObject({ total: 4, withComment: 3, pct: 75 });
  });

  it('repassa o período (start_date/end_date) para as agregações', async () => {
    mockResolveEnterprise.mockResolvedValueOnce(TEST_ENTERPRISE_ID);
    mockRatingAgg.mockResolvedValueOnce({ totalFeedbacks: 0, ratingSum: 0, ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
    mockAnalysisAgg.mockResolvedValueOnce({
      totalAnalyzed: 0,
      latestAnalysisAt: null,
      aiCounts: { positive: 0, neutral: 0, negative: 0 },
    });

    const res = await request(app)
      .get('/api/protected/user/feedbacks/stats')
      .query({ start_date: '2026-09-17T00:00:00-03:00', end_date: '2026-10-17T03:00:00Z' });

    expect(res.status).toBe(200);
    const period = { start: '2026-09-17T03:00:00.000Z', end: '2026-10-17T03:00:00.000Z' };
    expect(mockRatingAgg).toHaveBeenCalledWith(expect.objectContaining({ enterpriseId: TEST_ENTERPRISE_ID, period }));
    expect(mockAnalysisAgg).toHaveBeenCalledWith(expect.objectContaining({ enterpriseId: TEST_ENTERPRISE_ID, period }));
  });

  it('sem período mantém o histórico inteiro', async () => {
    mockResolveEnterprise.mockResolvedValueOnce(TEST_ENTERPRISE_ID);
    mockRatingAgg.mockResolvedValueOnce({ totalFeedbacks: 0, ratingSum: 0, ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
    mockAnalysisAgg.mockResolvedValueOnce({
      totalAnalyzed: 0,
      latestAnalysisAt: null,
      aiCounts: { positive: 0, neutral: 0, negative: 0 },
    });

    await request(app).get('/api/protected/user/feedbacks/stats');

    expect(mockRatingAgg).toHaveBeenCalledWith(expect.objectContaining({ period: { start: null, end: null } }));
  });

  it.each([
    '/api/protected/user/feedbacks/stats',
    '/api/protected/user/feedbacks/questions',
    '/api/protected/user/feedbacks/analysis',
  ])('%s responde 400 invalid_period com período inválido', async (path) => {
    const res = await request(app)
      .get(path)
      .query({ start_date: '2026-10-17T00:00:00Z', end_date: '2026-10-01T00:00:00Z' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_period');
    expect(mockResolveEnterprise).not.toHaveBeenCalled();
  });
});
