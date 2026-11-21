import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { requireAuth } from '../middlewares/auth.js';
import { allowPendingDeletion } from '../middlewares/allowPendingDeletion.js';
import { getPublicEnterpriseById } from '../repositories/publicEnterprise.repository.js';

const { getSession, execute } = vi.hoisted(() => ({ getSession: vi.fn(), execute: vi.fn() }));
vi.mock('../auth/auth.js', () => ({ getAuth: vi.fn(() => ({ api: { getSession } })) }));
vi.mock('../db/client.js', () => ({ getDb: vi.fn(() => ({ execute })), closeDb: vi.fn() }));

type MockRes = Response & { statusCode: number; body: unknown };

function mockRes(): MockRes {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload: unknown) => {
    res.body = payload;
    return res;
  };
  return res as MockRes;
}

const SESSION = {
  user: { id: '11111111-1111-4111-8111-111111111111', email: 'gestor@bompao.com.br' },
  session: { createdAt: '2026-11-21T10:00:00.000Z' },
};

function protectedRequest(): Request {
  return { path: '/protected/user/feedbacks', headers: { cookie: 'better-auth.session_token=sess' } } as unknown as Request;
}

// Passa pelo requireAuth como a rota faz: com ou sem o marcador allowPendingDeletion antes.
async function run(options: { allowPendingDeletion: boolean }) {
  const req = protectedRequest();
  const res = mockRes();
  if (options.allowPendingDeletion) allowPendingDeletion(req, res, vi.fn());
  const next = vi.fn() as unknown as NextFunction;
  await requireAuth(req, res, next);
  return { req, res, next };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue(SESSION);
});

describe('conta com exclusão agendada', () => {
  it('fica parada: as rotas protegidas respondem 403 com a data', async () => {
    execute.mockResolvedValue([{ id: 'ent-1', deletion_scheduled_for: '2026-12-06T12:00:00.000Z' }]);

    const { res, next } = await run({ allowPendingDeletion: false });

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: 'account_deletion_pending',
      deletion_scheduled_for: '2026-12-06T12:00:00.000Z',
    });
  });

  it('ainda lê o próprio usuário e pode desistir (allowPendingDeletion)', async () => {
    execute.mockResolvedValue([{ id: 'ent-1', deletion_scheduled_for: '2026-12-06T12:00:00.000Z' }]);

    const { req, next } = await run({ allowPendingDeletion: true });

    expect(next).toHaveBeenCalledOnce();
    expect(req.deletionScheduledFor).toEqual(new Date('2026-12-06T12:00:00.000Z'));
  });

  it('conta ativa segue normal, com a empresa e a data da sessão', async () => {
    execute.mockResolvedValue([{ id: 'ent-1', deletion_scheduled_for: null }]);

    const { req, next } = await run({ allowPendingDeletion: false });

    expect(next).toHaveBeenCalledOnce();
    expect(req.enterpriseId).toBe('ent-1');
    expect(req.deletionScheduledFor).toBeNull();
    expect(req.sessionCreatedAt).toEqual(new Date('2026-11-21T10:00:00.000Z'));
  });

  it('o formulário público não abre nem grava respostas para a empresa parada', async () => {
    execute.mockResolvedValue([]);

    await expect(getPublicEnterpriseById('ent-1')).resolves.toBeNull();

    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]![0] as SQL);
    expect(query.sql).toMatch(/NOT EXISTS/);
    expect(query.sql).toMatch(/u\.deletion_scheduled_for IS NOT NULL/);
  });
});
