import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../index.js';
import {
  fetchScopedRatingAggregates,
  fetchScopedAnalysisAggregates,
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
}));
vi.mock('../repositories/enterprise.repository.js', () => ({
  resolveEnterpriseIdByUser: vi.fn(),
}));

const mockRatingAgg = vi.mocked(fetchScopedRatingAggregates);
const mockAnalysisAgg = vi.mocked(fetchScopedAnalysisAggregates);
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

    const res = await request(app).get('/api/protected/user/feedbacks/stats');

    expect(res.status).toBe(200);
    expect(res.body.totalFeedbacks).toBe(4);
    expect(res.body.averageRating).toBe(4.3); // 17/4 = 4.25 → 4.3
    expect(res.body.ratingDistribution).toEqual({ 1: 0, 2: 0, 3: 1, 4: 1, 5: 2 });
    expect(res.body.pendingCount).toBe(4);
  });
});
