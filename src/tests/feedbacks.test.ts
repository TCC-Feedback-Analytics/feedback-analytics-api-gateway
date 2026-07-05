import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../index.js';
import { createSupabaseServerClient } from '../config/supabase.js';
import { makeMockSupabase, TEST_USER, TEST_ENTERPRISE } from './helpers/supabase-mock.js';
import {
  fetchScopedRatingAggregates,
  fetchScopedAnalysisAggregates,
} from '../repositories/feedbackStats.repository.js';
import { resolveEnterpriseIdByUser } from '../repositories/enterprise.repository.js';

vi.mock('../config/supabase.js', () => ({
  createSupabaseServerClient: vi.fn(),
}));

// As agregações de stats migraram para Drizzle; mockamos o repositório para
// testar o controller sem um banco real.
vi.mock('../repositories/feedbackStats.repository.js', () => ({
  fetchScopedRatingAggregates: vi.fn(),
  fetchScopedAnalysisAggregates: vi.fn(),
}));

// A resolução de empresa do stats também virou Drizzle (enterprise.repository);
// mockamos para o teste do controller (a resolução real é coberta por integração).
vi.mock('../repositories/enterprise.repository.js', () => ({
  resolveEnterpriseIdByUser: vi.fn(),
}));

const mockCreateClient = vi.mocked(createSupabaseServerClient);
const mockRatingAgg = vi.mocked(fetchScopedRatingAggregates);
const mockAnalysisAgg = vi.mocked(fetchScopedAnalysisAggregates);
const mockResolveEnterprise = vi.mocked(resolveEnterpriseIdByUser);

function setupAuthenticatedMock() {
  const mockSupabase = makeMockSupabase();
  mockSupabase.auth.getUser.mockResolvedValue({
    data: { user: TEST_USER },
    error: null,
  });
  mockCreateClient.mockReturnValue(mockSupabase as never);
  return mockSupabase;
}

describe('[Integração] GET /api/protected/user/feedbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retorna 401 sem autenticação', async () => {
    const mockSupabase = makeMockSupabase();
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Not authenticated' },
    });
    mockCreateClient.mockReturnValue(mockSupabase as never);

    const res = await request(app).get('/api/protected/user/feedbacks');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('[CT-UC10-02] retorna 404 quando empresa não encontrada', async () => {
    setupAuthenticatedMock();
    mockResolveEnterprise.mockResolvedValueOnce(null);

    const res = await request(app).get('/api/protected/user/feedbacks');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('enterprise_not_found');
  });

  // Os casos de dados da lista (paginação, filtros de rating/categoria, shape
  // aninhado) migraram para a suíte de integração — ver
  // src/tests/integration/feedbackList.itest.ts (contra o Postgres local).
});

describe('[Integração] GET /api/protected/user/feedbacks/stats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retorna 401 sem autenticação', async () => {
    const mockSupabase = makeMockSupabase();
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Not authenticated' },
    });
    mockCreateClient.mockReturnValue(mockSupabase as never);

    const res = await request(app).get('/api/protected/user/feedbacks/stats');

    expect(res.status).toBe(401);
  });

  it('[CT-UC09-01] retorna 200 com distribuição de ratings (agregação via Drizzle)', async () => {
    setupAuthenticatedMock();

    // enterprise resolvida via Drizzle (enterprise.repository, mockado).
    mockResolveEnterprise.mockResolvedValueOnce(TEST_ENTERPRISE.id);

    // Agregados servidos via Drizzle (mockados): notas 5,5,4,3 e nada analisado.
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
