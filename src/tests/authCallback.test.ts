import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { authCallbackController } from '../controllers/public/callback.controller.js';

const WEB = 'https://web.example';

type CookieCall = { name: string; value: string; options: Record<string, unknown> };
type MockRes = Response & { redirectedTo?: string; cookies: CookieCall[] };

function mockRes(): MockRes {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { cookies: [] as CookieCall[] };
  res.cookie = (name: string, value: string, options: Record<string, unknown>) => {
    res.cookies.push({ name, value, options });
    return res;
  };
  res.redirect = (url: string) => {
    res.redirectedTo = url;
    return res;
  };
  return res as MockRes;
}

function mockReq(query: Record<string, string>): Request {
  return { query } as unknown as Request;
}

describe('[Unidade] authCallbackController', () => {
  beforeEach(() => {
    vi.stubEnv('PUBLIC_SITE_URL', WEB);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('recovery com token: grava o cookie ba_reset e manda para o next', async () => {
    const res = mockRes();

    await authCallbackController(
      mockReq({ type: 'recovery', token: 'tok-123', next: '/auth/reset-password' }),
      res,
    );

    expect(res.cookies).toHaveLength(1);
    expect(res.cookies[0]).toMatchObject({
      name: 'ba_reset',
      value: 'tok-123',
      options: { httpOnly: true, path: '/api/protected/user/password' },
    });
    expect(res.redirectedTo).toBe(`${WEB}/auth/reset-password`);
  });

  it('recovery com error=INVALID_TOKEN: manda pedir link novo, sem cookie', async () => {
    const res = mockRes();

    await authCallbackController(
      mockReq({ type: 'recovery', next: '/auth/reset-password', error: 'INVALID_TOKEN' }),
      res,
    );

    expect(res.cookies).toHaveLength(0);
    expect(res.redirectedTo).toBe(`${WEB}/forgot-password?error=INVALID_TOKEN`);
  });

  it('recovery sem token e sem error: trata como link inválido, sem cookie', async () => {
    const res = mockRes();

    await authCallbackController(
      mockReq({ type: 'recovery', next: '/auth/reset-password' }),
      res,
    );

    expect(res.cookies).toHaveLength(0);
    expect(res.redirectedTo).toBe(`${WEB}/forgot-password?error=INVALID_TOKEN`);
  });

  it('outro tipo com error: vai para a tela de link expirado', async () => {
    const res = mockRes();

    await authCallbackController(mockReq({ error: 'TOKEN_EXPIRED' }), res);

    expect(res.cookies).toHaveLength(0);
    expect(res.redirectedTo).toBe(`${WEB}/auth/link-expired`);
  });

  it('caso padrão: vai para /auth/success com o next', async () => {
    const res = mockRes();

    await authCallbackController(mockReq({ next: '/user/dashboard' }), res);

    expect(res.cookies).toHaveLength(0);
    expect(res.redirectedTo).toBe(`${WEB}/auth/success?next=${encodeURIComponent('/user/dashboard')}`);
  });
});
