import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../index.js';
import { fetchScopedHeatmap } from '../repositories/feedbackHeatmap.repository.js';
import { resolveEnterpriseIdByUser } from '../repositories/enterprise.repository.js';
import { DAY_BANDS, WEEKDAYS, fillHeatmap } from '../libs/heatmap.js';

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
vi.mock('../repositories/feedbackHeatmap.repository.js', () => ({ fetchScopedHeatmap: vi.fn() }));
vi.mock('../repositories/enterprise.repository.js', () => ({ resolveEnterpriseIdByUser: vi.fn() }));

const mockHeatmap = vi.mocked(fetchScopedHeatmap);

describe('[Unit] dias e horários de pico — preenchimento', () => {
  it('sempre 28 células (7 dias × 4 faixas), na ordem, com zero onde não houve avaliação', () => {
    const cells = fillHeatmap([{ weekday: 6, band: 3, count: 4, ratingCount: 4, ratingSum: 13 }]);
    expect(cells).toHaveLength(WEEKDAYS * DAY_BANDS);
    expect(cells[0]).toEqual({ weekday: 0, band: 0, count: 0, mean: null });
    expect(cells[27]).toEqual({ weekday: 6, band: 3, count: 4, mean: 3.25 });
  });
});

describe('[Integração] GET /api/protected/user/feedbacks/heatmap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: TEST_USER_ID };
    vi.mocked(resolveEnterpriseIdByUser).mockResolvedValue(TEST_ENTERPRISE_ID);
  });

  it('retorna 401 sem autenticação', async () => {
    authState.user = null;
    const res = await request(app).get('/api/protected/user/feedbacks/heatmap');
    expect(res.status).toBe(401);
  });

  it('devolve as células e o total, repassando escopo, período e fuso', async () => {
    mockHeatmap.mockResolvedValueOnce([
      { weekday: 5, band: 2, count: 10, ratingCount: 10, ratingSum: 34 },
      { weekday: 6, band: 3, count: 3, ratingCount: 3, ratingSum: 15 },
    ]);

    const res = await request(app)
      .get('/api/protected/user/feedbacks/heatmap')
      .query({ tz: 'America/Sao_Paulo', start_date: '2026-09-18T03:00:00Z', end_date: '2026-10-19T03:00:00Z' });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(13);
    expect(res.body.cells).toHaveLength(28);
    expect(res.body.cells.find((c: { weekday: number; band: number }) => c.weekday === 5 && c.band === 2)).toEqual({
      weekday: 5,
      band: 2,
      count: 10,
      mean: 3.4,
    });
    expect(mockHeatmap).toHaveBeenCalledWith(
      expect.objectContaining({
        enterpriseId: TEST_ENTERPRISE_ID,
        timeZone: 'America/Sao_Paulo',
        period: { start: '2026-09-18T03:00:00.000Z', end: '2026-10-19T03:00:00.000Z' },
      }),
    );
  });

  it('fuso inválido → 400 invalid_timeline; período inválido → 400 invalid_period', async () => {
    const badTz = await request(app).get('/api/protected/user/feedbacks/heatmap').query({ tz: 'Marte/Olympus' });
    expect(badTz.status).toBe(400);
    expect(badTz.body.error).toBe('invalid_timeline');

    const badPeriod = await request(app)
      .get('/api/protected/user/feedbacks/heatmap')
      .query({ start_date: '2026-10-19T00:00:00Z', end_date: '2026-10-01T00:00:00Z' });
    expect(badPeriod.body.error).toBe('invalid_period');
    expect(mockHeatmap).not.toHaveBeenCalled();
  });
});
