import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { requireAuth } from '../middlewares/auth.js';
import { resetPasswordController } from '../controllers/protected/user.controller.js';
import { getAuth } from '../auth/auth.js';
import { getDb } from '../db/client.js';

const { getSession, resetPassword, execute } = vi.hoisted(() => ({
  getSession: vi.fn(),
  resetPassword: vi.fn(),
  execute: vi.fn(),
}));
vi.mock('../auth/auth.js', () => ({ getAuth: vi.fn(() => ({ api: { getSession, resetPassword } })) }));
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
  res.clearCookie = vi.fn();
  return res as MockRes;
}

const PASSWORD_ROUTE = '/protected/user/password';
const STRONG = 'Gato!Verde!Pulou';
const LOGGED_MANAGER = { user: { id: '11111111-1111-4111-8111-111111111111', email: 'gestor@bompao.com.br' } };

function passwordRequest(path: string, cookie?: string): Request {
  return {
    path,
    headers: cookie ? { cookie } : {},
    body: { password: STRONG, confirmPassword: STRONG },
  } as unknown as Request;
}

// Passa a requisição pelo requireAuth e, se ele deixar, pelo controller da nova senha,
// como faz a rota PATCH /api/protected/user/password.
async function patchPassword(req: Request) {
  const res = mockRes();
  const next = vi.fn() as unknown as NextFunction;
  await requireAuth(req, res, next);
  if (vi.mocked(next).mock.calls.length > 0) await resetPasswordController(req, res);
  return { res, next };
}

describe('requireAuth na rota de nova senha (cookie ba_reset)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuth).mockReturnValue({ api: { getSession, resetPassword } } as never);
    vi.mocked(getDb).mockReturnValue({ execute } as never);
    execute.mockResolvedValue([{ id: 'aaaaaaaa-0000-4000-8000-000000000001' }]);
    resetPassword.mockResolvedValue({ status: true });
  });

  it('gestor logado que abre o link de recuperação troca a senha', async () => {
    getSession.mockResolvedValue(LOGGED_MANAGER);
    const req = passwordRequest(PASSWORD_ROUTE, 'better-auth.session_token=sess; ba_reset=tok-123');

    const { res } = await patchPassword(req);

    expect(req.user?.id).toBe(LOGGED_MANAGER.user.id);
    expect(req.resetToken).toBe('tok-123');
    expect(resetPassword).toHaveBeenCalledWith({ body: { token: 'tok-123', newPassword: STRONG } });
    expect(res.statusCode).toBe(200);
    expect(res.clearCookie).toHaveBeenCalledWith('ba_reset', { path: `/api${PASSWORD_ROUTE}` });
  });

  it('sem sessão, o cookie ba_reset basta para trocar a senha', async () => {
    getSession.mockResolvedValue(null);
    const req = passwordRequest(PASSWORD_ROUTE, 'ba_reset=tok-123');

    const { res } = await patchPassword(req);

    expect(req.user).toBeUndefined();
    expect(resetPassword).toHaveBeenCalledWith({ body: { token: 'tok-123', newPassword: STRONG } });
    expect(res.statusCode).toBe(200);
  });

  it('gestor logado sem o cookie continua sem trocar a senha', async () => {
    getSession.mockResolvedValue(LOGGED_MANAGER);

    const { res } = await patchPassword(passwordRequest(PASSWORD_ROUTE, 'better-auth.session_token=sess'));

    expect(res.statusCode).toBe(401);
    expect((res.body as { error: string }).error).toBe('reset_password_invalid_token');
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it('o cookie ba_reset fora da rota de senha é ignorado, com ou sem sessão', async () => {
    getSession.mockResolvedValue(LOGGED_MANAGER);
    const logged = passwordRequest('/protected/user/email', 'better-auth.session_token=sess; ba_reset=tok-123');
    await requireAuth(logged, mockRes(), vi.fn() as unknown as NextFunction);
    expect(logged.resetToken).toBeUndefined();

    getSession.mockResolvedValue(null);
    const anonymous = passwordRequest('/protected/user/email', 'ba_reset=tok-123');
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;
    await requireAuth(anonymous, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('sem sessão e sem cookie responde 401 unauthorized', async () => {
    getSession.mockResolvedValue(null);

    const { res, next } = await patchPassword(passwordRequest(PASSWORD_ROUTE));

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });
});
