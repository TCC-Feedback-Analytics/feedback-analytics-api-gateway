import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { RequestHandler } from 'express';
import app from '../../index.js';
import { getSystemGuide, finishSystemGuide } from '../repositories/onboarding.repository.js';

const { auth } = vi.hoisted(() => ({ auth: { userId: 'user-a' as string | null } }));
vi.mock('../middlewares/auth.js', () => ({
  requireAuth: ((req, res, next) => {
    if (!auth.userId) return res.status(401).json({ error: 'unauthorized' });
    req.user = { id: auth.userId };
    next();
  }) satisfies RequestHandler,
}));
vi.mock('../repositories/onboarding.repository.js', () => ({
  SYSTEM_GUIDE_KEY: 'system-guide', SYSTEM_GUIDE_VERSION: 1,
  getSystemGuide: vi.fn(), finishSystemGuide: vi.fn(),
}));
const url = '/api/protected/user/onboarding/system-guide';
const row = {
  userId: 'user-a', tourKey: 'system-guide', version: 1,
  status: 'completed' as const, finishedAt: new Date('2026-09-10T12:00:00Z'),
};
beforeEach(() => {
  vi.resetAllMocks();
  auth.userId = 'user-a';
  vi.mocked(getSystemGuide).mockResolvedValue(null);
  vi.mocked(finishSystemGuide).mockResolvedValue(row);
});

describe('API onboarding', () => {
  it('sem registro retorna pending sem criar estado', async () => {
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ tourKey: 'system-guide', version: 1, status: 'pending', finishedAt: null });
    expect(getSystemGuide).toHaveBeenCalledWith('user-a');
    expect(finishSystemGuide).not.toHaveBeenCalled();
  });
  it('retorna estado persistido sem expor o ID do usuário', async () => {
    vi.mocked(getSystemGuide).mockResolvedValue(row);
    const res = await request(app).get(url);
    expect(res.body).toEqual({ tourKey: 'system-guide', version: 1, status: 'completed', finishedAt: row.finishedAt.toISOString() });
  });
  it.each(['completed', 'skipped'] as const)('grava %s usando a sessão', async (status) => {
    auth.userId = 'user-b';
    const res = await request(app).put(url).send({ version: 1, status });
    expect(res.status).toBe(200);
    expect(finishSystemGuide).toHaveBeenCalledWith('user-b', status);
    // A resposta é o estado efetivamente salvo, não um eco do pedido.
    expect(res.body.status).toBe('completed');
  });
  it.each([
    {}, { status: 'completed' }, { version: 2, status: 'completed' },
    { version: '1', status: 'completed' }, { version: 1, status: 'pending' },
    { version: 1, status: 'completed', userId: 'victim' },
    { version: 1, status: 'skipped', finishedAt: '2020-01-01' },
  ])('rejeita payload inválido %j', async (body) => {
    expect((await request(app).put(url).send(body)).status).toBe(400);
    expect(finishSystemGuide).not.toHaveBeenCalled();
  });
  it('nega leitura e escrita sem sessão', async () => {
    auth.userId = null;
    expect((await request(app).get(url)).status).toBe(401);
    expect((await request(app).put(url).send({ version: 1, status: 'completed' })).status).toBe(401);
    expect(getSystemGuide).not.toHaveBeenCalled();
    expect(finishSystemGuide).not.toHaveBeenCalled();
  });
  it('não converte falhas do banco em pending ou sucesso', async () => {
    vi.mocked(getSystemGuide).mockRejectedValue(new Error('private connection details'));
    vi.mocked(finishSystemGuide).mockRejectedValue(new Error('private connection details'));
    for (const res of [await request(app).get(url), await request(app).put(url).send({ version: 1, status: 'completed' })]) {
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'internal_error' });
    }
  });
});
