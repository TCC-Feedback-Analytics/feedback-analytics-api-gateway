/**
 * Limite de tentativas no login, na nova senha e no cadastro (tabela auth_rate_limit).
 *
 * A primeira parte roda a lógica do limite contra uma tabela em memória, que
 * responde aos três comandos SQL usados (gastar, devolver e limpar vagas). A
 * segunda confere os controllers com o limite simulado.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { getDb } from '../db/client.js';

vi.mock('../db/client.js', () => ({ getDb: vi.fn(), closeDb: vi.fn() }));

const { releaseAuthAttempt, reserveAuthAttempt } = await vi.importActual<
  typeof import('../libs/authRateLimit.js')
>('../libs/authRateLimit.js');

const dialect = new PgDialect();
let table: Map<string, { used: number; expiresAt: number }>;
let now: number;

/** Responde como o Postgres aos comandos do limite; o resto não chega aqui. */
async function fakeExecute(query: SQL) {
  const { sql: text, params } = dialect.sqlToQuery(query);
  if (text.includes('INSERT INTO auth_rate_limit')) {
    const [key, seconds, cap] = params as [string, number, number];
    const row = table.get(key);
    if (!row || row.expiresAt <= now) {
      table.set(key, { used: 1, expiresAt: now + seconds * 1000 });
    } else {
      row.used = Math.min(row.used + 1, cap);
    }
    const saved = table.get(key)!;
    return [{ used: saved.used, retry: Math.ceil((saved.expiresAt - now) / 1000) }];
  }
  if (text.includes('GREATEST(used - 1, 0)')) {
    for (const key of params as string[]) {
      const row = table.get(key);
      if (row && row.expiresAt > now) row.used = Math.max(row.used - 1, 0);
    }
    return [];
  }
  if (text.includes('DELETE FROM auth_rate_limit')) return [];
  throw new Error(`SQL inesperado: ${text}`);
}

beforeEach(() => {
  table = new Map();
  now = Date.UTC(2026, 10, 16, 12);
  vi.mocked(getDb).mockReturnValue({ execute: vi.fn(fakeExecute) } as never);
});

async function attempts(action: Parameters<typeof reserveAuthAttempt>[0], times: number, ip: string, email: string) {
  const results = [];
  for (let i = 0; i < times; i += 1) results.push(await reserveAuthAttempt(action, ip, email));
  return results;
}

describe('limite de tentativas no banco', () => {
  it('o login bloqueia o e-mail na 11ª tentativa errada em 15 minutos, mesmo vindo de IPs diferentes', async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await reserveAuthAttempt('login', `198.51.100.${i}`, 'gestor@padaria.com')).allowed).toBe(true);
    }
    const blocked = await reserveAuthAttempt('login', '198.51.100.99', 'Gestor@Padaria.com ');
    expect(blocked).toEqual({ allowed: false, retryAfterSeconds: 900 });
  });

  it('login certo devolve a vaga: quem entra várias vezes não fica bloqueado', async () => {
    for (let i = 0; i < 30; i += 1) {
      expect((await reserveAuthAttempt('login', '198.51.100.1', 'gestor@padaria.com')).allowed).toBe(true);
      await releaseAuthAttempt('login', '198.51.100.1', 'gestor@padaria.com');
    }
  });

  it('o login bloqueia o IP que tenta muitos e-mails, sem gastar a vaga do e-mail', async () => {
    for (let i = 0; i < 100; i += 1) {
      expect((await reserveAuthAttempt('login', '203.0.113.7', `pessoa${i}@exemplo.com`)).allowed).toBe(true);
    }
    expect((await reserveAuthAttempt('login', '203.0.113.7', 'gestor@padaria.com')).allowed).toBe(false);
    expect((await reserveAuthAttempt('login', '198.51.100.1', 'gestor@padaria.com')).allowed).toBe(true);
  });

  it('a nova senha aceita cinco pedidos por e-mail em uma hora e libera depois da janela', async () => {
    const results = await attempts('forgot-password', 6, '198.51.100.1', 'gestor@padaria.com');
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, true, true, false]);
    expect(results[5]!.retryAfterSeconds).toBe(3600);

    now += 3600 * 1000;
    expect((await reserveAuthAttempt('forgot-password', '198.51.100.1', 'gestor@padaria.com')).allowed).toBe(true);
  });

  it('cada rota conta à parte e a chave guarda só o HMAC do IP e do e-mail', async () => {
    await attempts('register', 5, '198.51.100.1', 'gestor@padaria.com');
    expect((await reserveAuthAttempt('register', '198.51.100.1', 'gestor@padaria.com')).allowed).toBe(false);
    expect((await reserveAuthAttempt('login', '198.51.100.1', 'gestor@padaria.com')).allowed).toBe(true);

    const keys = [...table.keys()];
    expect(keys.every((key) => /^(register|login):(ip|email):[a-f0-9]{64}$/.test(key))).toBe(true);
    expect(keys.join()).not.toContain('padaria');
    expect(keys.join()).not.toContain('198.51.100.1');
  });

  it('o limite pode ser ajustado pelo ambiente', async () => {
    vi.stubEnv('LOGIN_EMAIL_MAX', '2');
    try {
      const results = await attempts('login', 3, '198.51.100.1', 'gestor@padaria.com');
      expect(results.map((r) => r.allowed)).toEqual([true, true, false]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

const auth = vi.hoisted(() => ({
  signInEmail: vi.fn(),
  requestPasswordReset: vi.fn(),
  signUpEmail: vi.fn(),
}));
vi.mock('../auth/auth.js', () => ({ getAuth: () => ({ api: auth }) }));

const limiter = vi.hoisted(() => ({
  authClientIp: vi.fn(() => '203.0.113.7'),
  reserveAuthAttempt: vi.fn(),
  releaseAuthAttempt: vi.fn(),
}));
vi.mock('../libs/authRateLimit.js', () => limiter);

const { loginController } = await import('../controllers/public/auth.controller.js');
const { forgotPasswordController } = await import('../controllers/public/forgotPassword.controller.js');
const { registerUserController } = await import('../controllers/public/register.controller.js');

type MockRes = Response & { statusCode: number; body: unknown; headers: Record<string, string> };

function mockRes(): MockRes {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { statusCode: 200, body: undefined, headers: {} };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload: unknown) => {
    res.body = payload;
    return res;
  };
  res.setHeader = (name: string, value: string) => {
    res.headers[name.toLowerCase()] = value;
  };
  res.appendHeader = vi.fn();
  return res as MockRes;
}

function mockReq(body: unknown): Request {
  return {
    body,
    headers: { 'user-agent': 'Mozilla/5.0 (iPhone)', 'x-forwarded-for': '203.0.113.7' },
    protocol: 'https',
    get: () => 'api.exemplo.com',
  } as unknown as Request;
}

const LOGIN = { email: 'gestor@padaria.com', password: 'Gato!Verde!Pulou', remember: false };
const blocked = { allowed: false, retryAfterSeconds: 420 };

describe('rotas públicas com o limite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limiter.reserveAuthAttempt.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    auth.signInEmail.mockResolvedValue({
      headers: new Headers(),
      response: { user: { id: 'u1', email: LOGIN.email } },
    });
  });

  it('login bloqueado responde 429 tipado, em português, e nem confere a senha', async () => {
    limiter.reserveAuthAttempt.mockResolvedValue(blocked);
    const res = mockRes();
    await loginController(mockReq(LOGIN), res);

    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('420');
    expect(res.body).toEqual({
      error: 'rate_limited',
      message: 'Muitas tentativas de login. Aguarde alguns minutos e tente novamente.',
      retryAfterSeconds: 420,
    });
    expect(auth.signInEmail).not.toHaveBeenCalled();
    expect(limiter.reserveAuthAttempt).toHaveBeenCalledWith('login', '203.0.113.7', LOGIN.email);
  });

  it('login certo leva o IP e o navegador para a sessão e devolve a vaga', async () => {
    const res = mockRes();
    await loginController(mockReq(LOGIN), res);

    expect(res.statusCode).toBe(200);
    const call = auth.signInEmail.mock.calls[0]![0] as { headers: Headers };
    expect(call.headers.get('user-agent')).toBe('Mozilla/5.0 (iPhone)');
    expect(call.headers.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(limiter.releaseAuthAttempt).toHaveBeenCalledWith('login', '203.0.113.7', LOGIN.email);
  });

  it('senha errada gasta a vaga: não devolve', async () => {
    const { APIError } = await import('better-auth/api');
    auth.signInEmail.mockRejectedValue(new APIError('UNAUTHORIZED', { message: 'Invalid email or password' }));
    const res = mockRes();
    await loginController(mockReq(LOGIN), res);

    expect(res.statusCode).toBe(401);
    expect(limiter.releaseAuthAttempt).not.toHaveBeenCalled();
  });

  it('nova senha bloqueada responde 429 sem mandar e-mail', async () => {
    limiter.reserveAuthAttempt.mockResolvedValue(blocked);
    const res = mockRes();
    await forgotPasswordController(mockReq({ email: LOGIN.email }), res);

    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({ error: 'rate_limited', message: 'Muitos pedidos de nova senha. Aguarde e tente novamente.' });
    expect(auth.requestPasswordReset).not.toHaveBeenCalled();
  });

  it('nova senha sem o controle do limite responde 503 e não manda e-mail', async () => {
    limiter.reserveAuthAttempt.mockRejectedValue(new Error('db indisponível'));
    const res = mockRes();
    await forgotPasswordController(mockReq({ email: LOGIN.email }), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: 'service_unavailable' });
    expect(auth.requestPasswordReset).not.toHaveBeenCalled();
  });

  it('cadastro bloqueado responde 429 sem criar a conta nem mandar a confirmação', async () => {
    limiter.reserveAuthAttempt.mockResolvedValue(blocked);
    const res = mockRes();
    await registerUserController(mockReq({
      fullName: 'Padaria Bom Pão',
      email: LOGIN.email,
      phone: '+5511987654321',
      password: LOGIN.password,
      confirmPassword: LOGIN.password,
      terms: true,
    }), res);

    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({
      error: 'rate_limited',
      message: 'Muitas tentativas de cadastro em pouco tempo. Aguarde e tente novamente.',
    });
    expect(limiter.reserveAuthAttempt).toHaveBeenCalledWith('register', '203.0.113.7', LOGIN.email);
    expect(auth.signUpEmail).not.toHaveBeenCalled();
  });
});
