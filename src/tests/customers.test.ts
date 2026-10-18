import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../index.js';
import { fetchScopedCustomerVisits } from '../repositories/feedbackCustomers.repository.js';
import { resolveEnterpriseIdByUser } from '../repositories/enterprise.repository.js';

const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';
const TEST_ENTERPRISE_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

const { authState } = vi.hoisted(() => ({
  authState: { user: null as { id: string } | null },
}));
vi.mock('../middlewares/auth.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requireAuth: (req: any, res: any, next: any) => {
    if (!authState.user) return res.status(401).json({ error: 'unauthorized' });
    req.user = authState.user;
    next();
  },
}));
vi.mock('../repositories/feedbackCustomers.repository.js', () => ({ fetchScopedCustomerVisits: vi.fn() }));
vi.mock('../repositories/enterprise.repository.js', () => ({ resolveEnterpriseIdByUser: vi.fn() }));

const mockVisits = vi.mocked(fetchScopedCustomerVisits);

describe('[Integração] GET /api/protected/user/feedbacks/customers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: TEST_USER_ID };
    vi.mocked(resolveEnterpriseIdByUser).mockResolvedValue(TEST_ENTERPRISE_ID);
  });

  it('retorna 401 sem autenticação', async () => {
    authState.user = null;
    const res = await request(app).get('/api/protected/user/feedbacks/customers');
    expect(res.status).toBe(401);
  });

  it('resume quem volta e quem avalia pela primeira vez, repassando escopo e período', async () => {
    mockVisits.mockResolvedValueOnce({
      rows: [
        { visit: 'first', rating: 4, count: 40 },
        { visit: 'returning', rating: 5, count: 10 },
      ],
      customers: 45,
      returningCustomers: 7,
    });

    const res = await request(app)
      .get('/api/protected/user/feedbacks/customers')
      .query({ start_date: '2026-09-18T03:00:00Z', end_date: '2026-10-19T03:00:00Z' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      identified: 50,
      returningCount: 10,
      returningPct: 20,
      customers: 45,
      returningCustomers: 7,
      returning: { n: 10, mean: 5 },
      firstTime: { n: 40, mean: 4 },
    });
    expect(mockVisits).toHaveBeenCalledWith(
      expect.objectContaining({
        enterpriseId: TEST_ENTERPRISE_ID,
        period: { start: '2026-09-18T03:00:00.000Z', end: '2026-10-19T03:00:00.000Z' },
      }),
    );
  });

  it('período inválido → 400 invalid_period', async () => {
    const res = await request(app)
      .get('/api/protected/user/feedbacks/customers')
      .query({ start_date: '2026-10-19T00:00:00Z', end_date: '2026-10-01T00:00:00Z' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_period');
    expect(mockVisits).not.toHaveBeenCalled();
  });
});
