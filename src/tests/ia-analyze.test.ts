import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../index.js';
import { analyzeRawFeedbacks, regenerateFeedbackInsights } from '../services/iaAnalyze.service.js';
import { IaAnalyzeServiceError } from '../libs/iaAnalyze/errors.js';
import { resolveEnterpriseIdByUser } from '../repositories/enterprise.repository.js';

const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';
const TEST_ENTERPRISE_ID = 'ent-1';

// requireAuth mockado: o gating real (sessão Better Auth) é coberto pelo e2e.
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

vi.mock('../services/iaAnalyze.service.js', () => ({
  analyzeRawFeedbacks: vi.fn(),
  regenerateFeedbackInsights: vi.fn(),
}));
vi.mock('../repositories/enterprise.repository.js', () => ({
  resolveEnterpriseIdByUser: vi.fn(),
}));

const mockAnalyzeRawFeedbacks = vi.mocked(analyzeRawFeedbacks);
const mockRegenerateFeedbackInsights = vi.mocked(regenerateFeedbackInsights);
const mockResolveEnterprise = vi.mocked(resolveEnterpriseIdByUser);

describe('[Integração] POST /api/protected/ia-analyze/analyze-raw', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: TEST_USER_ID };
    mockResolveEnterprise.mockResolvedValue(TEST_ENTERPRISE_ID);
  });

  it('retorna 401 sem autenticação', async () => {
    authState.user = null;
    const res = await request(app).post('/api/protected/ia-analyze/analyze-raw').send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('[CT-UC11-02] retorna 200 com resultado da análise IA', async () => {
    mockAnalyzeRawFeedbacks.mockResolvedValueOnce({
      analyzedCount: 5,
      feedbacksAnalyzed: Array.from({ length: 5 }, (_, i) => ({
        id: `analysis-${i + 1}`,
        feedback_id: `feedback-${i + 1}`,
        sentiment: 'positive',
        categories: ['atendimento'],
        keywords: ['rápido'],
      })),
    });

    const res = await request(app).post('/api/protected/ia-analyze/analyze-raw').send({});

    expect(res.status).toBe(200);
    expect(res.body.analyzedCount).toBe(5);
  });

  it('[CT-UC11-07] retorna erro tipado quando o serviço IA lança IaAnalyzeServiceError', async () => {
    mockAnalyzeRawFeedbacks.mockRejectedValueOnce(
      new IaAnalyzeServiceError('Sem feedbacks suficientes', 422, 'insufficient_feedbacks'),
    );

    const res = await request(app).post('/api/protected/ia-analyze/analyze-raw').send({});

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('insufficient_feedbacks');
  });

  it('retorna 500 para erro inesperado do serviço', async () => {
    mockAnalyzeRawFeedbacks.mockRejectedValueOnce(new Error('Erro inesperado'));

    const res = await request(app).post('/api/protected/ia-analyze/analyze-raw').send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('internal_server_error');
  });
});

describe('[Integração] POST /api/protected/ia-analyze/regenerate-insights', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: TEST_USER_ID };
    mockResolveEnterprise.mockResolvedValue(TEST_ENTERPRISE_ID);
  });

  it('retorna 401 sem autenticação', async () => {
    authState.user = null;
    const res = await request(app).post('/api/protected/ia-analyze/regenerate-insights').send({});
    expect(res.status).toBe(401);
  });

  it('[CT-UC11-04] retorna 200 com insights regenerados', async () => {
    mockRegenerateFeedbackInsights.mockResolvedValueOnce({
      globalInsights: {
        summary: 'Clientes satisfeitos com o atendimento.',
        recommendations: ['Manter tempo de resposta'],
      },
      contexts: [
        {
          scope_type: 'COMPANY',
          catalog_item_id: null,
          catalog_item_name: null,
          analyzedCount: 3,
          globalInsights: {
            summary: 'Clientes satisfeitos com o atendimento.',
            recommendations: ['Manter tempo de resposta'],
          },
        },
      ],
      reportGenerated: true,
      fromCache: false,
    });

    const res = await request(app).post('/api/protected/ia-analyze/regenerate-insights').send({});

    expect(res.status).toBe(200);
    expect(res.body.reportGenerated).toBe(true);
    expect(res.body.contexts).toHaveLength(1);
  });
});
