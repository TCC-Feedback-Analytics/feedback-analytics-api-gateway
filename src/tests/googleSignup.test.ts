import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { googleProviderConfig, provisionEnterpriseForSocialAccount } from '../auth/auth.js';
import { completeSignupController } from '../controllers/protected/completeSignup.controller.js';
import { provisionEnterpriseForUser } from '../auth/enterpriseOnSignup.js';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../db/client.js', () => ({ getDb: () => ({ execute }), closeDb: vi.fn() }));
vi.mock('../auth/enterpriseOnSignup.js', () => ({ provisionEnterpriseForUser: vi.fn() }));

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
const req = (body: unknown) => ({ user: { id: 'user-1' }, body } as unknown as Request);

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockResolvedValue([]);
});

describe('Entrar com Google: configuração', () => {
  it('só liga com as duas credenciais no ambiente', () => {
    expect(googleProviderConfig({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' } as NodeJS.ProcessEnv))
      .toEqual({ google: { clientId: 'id', clientSecret: 'secret' } });
    expect(googleProviderConfig({ GOOGLE_CLIENT_ID: 'id' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(googleProviderConfig({} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe('Entrar com Google: empresa da conta nova', () => {
  it('conta do Google cria a empresa, sem os termos', async () => {
    await provisionEnterpriseForSocialAccount({ userId: 'user-1', providerId: 'google' });
    expect(provisionEnterpriseForUser).toHaveBeenCalledWith('user-1', {});
  });

  it('conta com senha não cria aqui (o cadastro com senha cria no controller)', async () => {
    await provisionEnterpriseForSocialAccount({ userId: 'user-1', providerId: 'credential' });
    expect(provisionEnterpriseForUser).not.toHaveBeenCalled();
  });

  it('falha ao criar não derruba a entrada', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(provisionEnterpriseForUser).mockRejectedValueOnce(new Error('db'));
    await expect(provisionEnterpriseForSocialAccount({ userId: 'user-1', providerId: 'google' })).resolves.toBeUndefined();
  });
});

describe('Complete seu cadastro', () => {
  const valid = { fullName: 'Padaria Bom Pão', phone: '+5511987654321', terms: true };

  it('grava nome do negócio e telefone e o aceite dos termos na empresa', async () => {
    const res = mockRes();
    await completeSignupController(req(valid), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const update = new PgDialect().sqlToQuery(execute.mock.calls[1][0] as SQL);
    expect(update.sql).toContain('UPDATE public."user" SET name =');
    expect(update.params).toEqual(['Padaria Bom Pão', '+5511987654321', 'user-1']);
    expect(provisionEnterpriseForUser).toHaveBeenCalledWith('user-1', { termsVersion: 'v1', termsAcceptedAt: expect.any(String) });
  });

  it('telefone de outra conta → 409 phone_taken, sem gravar', async () => {
    execute.mockResolvedValueOnce([{ '?column?': 1 }]);
    const res = mockRes();
    await completeSignupController(req(valid), res);
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toBe('phone_taken');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('sem aceitar os termos, telefone fora do formato ou nome curto → 400', async () => {
    for (const body of [{ ...valid, terms: false }, { ...valid, phone: '11987654321' }, { ...valid, fullName: 'A' }]) {
      const res = mockRes();
      await completeSignupController(req(body), res);
      expect(res.statusCode).toBe(400);
    }
    expect(execute).not.toHaveBeenCalled();
  });
});
