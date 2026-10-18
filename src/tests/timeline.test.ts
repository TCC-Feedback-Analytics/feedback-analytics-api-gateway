import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../index.js';
import { fetchScopedTimeline } from '../repositories/feedbackTimeline.repository.js';
import { resolveEnterpriseIdByUser } from '../repositories/enterprise.repository.js';
import {
  TIMELINE_MAX_POINTS,
  bucketStart,
  fillTimeline,
  localDateOf,
  parseTimelineBucket,
  parseTimezone,
} from '../libs/timeline.js';

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
vi.mock('../repositories/feedbackTimeline.repository.js', () => ({ fetchScopedTimeline: vi.fn() }));
vi.mock('../repositories/enterprise.repository.js', () => ({ resolveEnterpriseIdByUser: vi.fn() }));

const mockTimeline = vi.mocked(fetchScopedTimeline);
const mockResolveEnterprise = vi.mocked(resolveEnterpriseIdByUser);

describe('[Unit] movimento no tempo — parâmetros e preenchimento', () => {
  it('agrupamento: dia por padrão; só dia, semana ou mês', () => {
    expect(parseTimelineBucket(undefined)).toBe('day');
    expect(parseTimelineBucket('week')).toBe('week');
    expect(parseTimelineBucket('year')).toBeNull();
  });

  it('fuso: IANA válido, padrão sem fuso e recusa o resto', () => {
    expect(parseTimezone(undefined)).toBe('America/Sao_Paulo');
    expect(parseTimezone('America/Argentina/Buenos_Aires')).toBe('America/Argentina/Buenos_Aires');
    expect(parseTimezone('UTC')).toBe('UTC');
    expect(parseTimezone('Marte/Olympus')).toBeNull();
    expect(parseTimezone("UTC'; drop table feedback")).toBeNull();
  });

  it('a data local depende do fuso', () => {
    const instant = new Date('2026-10-18T02:00:00Z');
    expect(localDateOf(instant, 'UTC')).toBe('2026-10-18');
    expect(localDateOf(instant, 'America/Sao_Paulo')).toBe('2026-10-17');
  });

  it('início do intervalo como o date_trunc: semana na segunda, mês no dia 1', () => {
    expect(bucketStart('2026-10-18', 'day')).toBe('2026-10-18');
    expect(bucketStart('2026-10-18', 'week')).toBe('2026-10-12'); // domingo → segunda anterior
    expect(bucketStart('2026-10-12', 'week')).toBe('2026-10-12');
    expect(bucketStart('2026-10-18', 'month')).toBe('2026-10-01');
  });

  it('preenche os intervalos sem avaliação com zero e calcula a média', () => {
    const points = fillTimeline(
      [
        { start: '2026-10-14', count: 2, ratingCount: 2, ratingSum: 9 },
        { start: '2026-10-16', count: 3, ratingCount: 3, ratingSum: 10 },
      ],
      { fromDate: '2026-10-13', toDate: '2026-10-16', bucket: 'day' },
    );
    expect(points).toEqual([
      { start: '2026-10-13', count: 0, mean: null },
      { start: '2026-10-14', count: 2, mean: 4.5 },
      { start: '2026-10-15', count: 0, mean: null },
      { start: '2026-10-16', count: 3, mean: 3.33 },
    ]);
  });

  it('meses atravessam o fim do ano e há um teto de pontos', () => {
    const months = fillTimeline([], { fromDate: '2026-11-20', toDate: '2027-02-03', bucket: 'month' });
    expect(months?.map((point) => point.start)).toEqual(['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01']);
    expect(fillTimeline([], { fromDate: '2020-01-01', toDate: '2026-01-01', bucket: 'day' })).toBeNull();
    expect(TIMELINE_MAX_POINTS).toBeGreaterThan(366);
  });
});

describe('[Integração] GET /api/protected/user/feedbacks/timeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: TEST_USER_ID };
    mockResolveEnterprise.mockResolvedValue(TEST_ENTERPRISE_ID);
  });

  it('retorna 401 sem autenticação', async () => {
    authState.user = null;
    const res = await request(app).get('/api/protected/user/feedbacks/timeline');
    expect(res.status).toBe(401);
  });

  it('com período, vai do início ao fim no fuso pedido e repassa tudo ao repositório', async () => {
    mockTimeline.mockResolvedValueOnce([{ start: '2026-10-15', count: 4, ratingCount: 4, ratingSum: 18 }]);

    const res = await request(app).get('/api/protected/user/feedbacks/timeline').query({
      start_date: '2026-10-12T03:00:00.000Z',
      end_date: '2026-10-19T03:00:00.000Z',
      bucket: 'day',
      tz: 'America/Sao_Paulo',
    });

    expect(res.status).toBe(200);
    expect(res.body.bucket).toBe('day');
    expect(res.body.total).toBe(4);
    expect(res.body.points).toHaveLength(7);
    expect(res.body.points[0]).toEqual({ start: '2026-10-12', count: 0, mean: null });
    expect(res.body.points[3]).toEqual({ start: '2026-10-15', count: 4, mean: 4.5 });
    expect(res.body.points[6].start).toBe('2026-10-18');
    expect(mockTimeline).toHaveBeenCalledWith(
      expect.objectContaining({
        enterpriseId: TEST_ENTERPRISE_ID,
        bucket: 'day',
        timeZone: 'America/Sao_Paulo',
        period: { start: '2026-10-12T03:00:00.000Z', end: '2026-10-19T03:00:00.000Z' },
      }),
    );
  });

  it('sem período, começa na primeira avaliação', async () => {
    mockTimeline.mockResolvedValueOnce([{ start: '2026-01-01', count: 1, ratingCount: 1, ratingSum: 5 }]);

    const res = await request(app).get('/api/protected/user/feedbacks/timeline').query({ bucket: 'month' });

    expect(res.status).toBe(200);
    expect(res.body.points[0]).toEqual({ start: '2026-01-01', count: 1, mean: 5 });
    expect(res.body.tz).toBe('America/Sao_Paulo');
  });

  it('agrupamento ou fuso inválido → 400 invalid_timeline', async () => {
    const bad = await request(app).get('/api/protected/user/feedbacks/timeline').query({ bucket: 'year' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_timeline');

    const badTz = await request(app).get('/api/protected/user/feedbacks/timeline').query({ tz: 'Marte/Olympus' });
    expect(badTz.body.error).toBe('invalid_timeline');
    expect(mockTimeline).not.toHaveBeenCalled();
  });

  it('intervalo longo demais para o agrupamento → 400 timeline_too_many_points', async () => {
    mockTimeline.mockResolvedValueOnce([{ start: '2020-01-01', count: 1, ratingCount: 1, ratingSum: 5 }]);

    const res = await request(app).get('/api/protected/user/feedbacks/timeline').query({ bucket: 'day' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('timeline_too_many_points');
  });
});
