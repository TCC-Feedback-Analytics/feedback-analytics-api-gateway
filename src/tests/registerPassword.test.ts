import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { isStrongPassword, passwordScore } from '../libs/passwordStrength.js';
import { registerUserController } from '../controllers/public/register.controller.js';
import { resetPasswordController } from '../controllers/protected/user.controller.js';
import { getAuth } from '../auth/auth.js';
import { getDb } from '../db/client.js';
import { provisionEnterpriseForUser } from '../auth/enterpriseOnSignup.js';

const { signUpEmail, resetPassword, execute } = vi.hoisted(() => ({
  signUpEmail: vi.fn(),
  resetPassword: vi.fn(),
  execute: vi.fn(),
}));
vi.mock('../auth/auth.js', () => ({ getAuth: vi.fn(() => ({ api: { signUpEmail, resetPassword } })) }));
vi.mock('../db/client.js', () => ({ getDb: vi.fn(() => ({ execute })), closeDb: vi.fn() }));
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
  res.clearCookie = vi.fn();
  return res as MockRes;
}

const STRONG = 'Gato!Verde!Pulou';
const body = (password: string) => ({
  fullName: 'Padaria Bom Pão',
  email: 'contato@bompao.com.br',
  phone: '+5511987654321',
  password,
  confirmPassword: password,
  terms: true,
});

describe('força da senha (zxcvbn)', () => {
  it('palavra + número + a mesma palavra não passa; frase curta e palavras com símbolo passam', () => {
    expect(isStrongPassword('Palavra123palavra')).toBe(false);
    expect(isStrongPassword('Senha12345')).toBe(false);
    expect(isStrongPassword('sol azul de manha')).toBe(true);
    expect(isStrongPassword(STRONG)).toBe(true);
  });

  it('não aceita senha curta, mesmo aleatória', () => {
    expect(isStrongPassword('Xk9#mQ2v')).toBe(false);
  });

  it('dados da pessoa dentro da senha derrubam a nota', () => {
    // "Bom Pão" vira bom, pao e bompao: a senha com o nome do negócio deixa de ser forte.
    expect(passwordScore('PadariaBomPao!2026')).toBe(4);
    expect(passwordScore('PadariaBomPao!2026', ['Padaria Bom Pão'])).toBeLessThan(4);
    expect(isStrongPassword('bompao2026contato', ['contato@bompao.com.br'])).toBe(false);
  });
});

describe('cadastro sem CPF/CNPJ e com senha forte', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuth).mockReturnValue({ api: { signUpEmail, resetPassword } } as never);
    vi.mocked(getDb).mockReturnValue({ execute } as never);
    execute.mockResolvedValue([]);
    signUpEmail.mockResolvedValue({ user: { id: '11111111-1111-1111-1111-111111111111' } });
  });

  it('senha fraca volta 400 password_too_weak sem criar o usuário', async () => {
    const res = mockRes();
    await registerUserController({ body: body('Palavra123palavra') } as Request, res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe('password_too_weak');
    expect(signUpEmail).not.toHaveBeenCalled();
  });

  it('senha de menos de 10 caracteres para no schema', async () => {
    const res = mockRes();
    await registerUserController({ body: body('Gato!Ver9') } as Request, res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe('invalid_payload');
  });

  it('cadastra sem pedir nem gravar documento', async () => {
    const res = mockRes();
    await registerUserController({ body: body(STRONG) } as Request, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, message: 'confirmation_required' });
    expect(signUpEmail).toHaveBeenCalledWith({ body: expect.objectContaining({ name: 'Padaria Bom Pão', password: STRONG }) });
    expect(provisionEnterpriseForUser).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111', {
      termsVersion: 'v1',
      termsAcceptedAt: expect.any(String),
    });
  });
});

describe('redefinição de senha', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuth).mockReturnValue({ api: { signUpEmail, resetPassword } } as never);
  });

  it('senha fraca volta 400 reset_password_weak sem redefinir', async () => {
    const res = mockRes();
    await resetPasswordController({ body: { password: 'Palavra123palavra', confirmPassword: 'Palavra123palavra' }, resetToken: 'tok' } as unknown as Request, res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe('reset_password_weak');
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it('senha forte redefine', async () => {
    resetPassword.mockResolvedValue({ status: true });
    const res = mockRes();
    await resetPasswordController({ body: { password: STRONG, confirmPassword: STRONG }, resetToken: 'tok' } as unknown as Request, res);
    expect(res.statusCode).toBe(200);
    expect(resetPassword).toHaveBeenCalledWith({ body: { token: 'tok', newPassword: STRONG } });
  });
});
