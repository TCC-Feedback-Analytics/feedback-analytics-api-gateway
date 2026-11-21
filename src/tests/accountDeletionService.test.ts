import { vi, describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const mocks = vi.hoisted(() => ({
  findPasswordHash: vi.fn(),
  saveDeletionToken: vi.fn(),
  consumeDeletionToken: vi.fn(),
  scheduleDeletion: vi.fn(),
  cancelDeletion: vi.fn(),
  findAccountsDueForDeletion: vi.fn(),
  purgeAccount: vi.fn(),
  consumeQuota: vi.fn(),
  verifyBetterAuthPassword: vi.fn(),
  sendAccountDeletionConfirmation: vi.fn(),
  sendAccountDeletionScheduled: vi.fn(),
  sendAccountDeletionCancelled: vi.fn(),
  sendAccountDeleted: vi.fn(),
}));

vi.mock('../repositories/accountDeletion.repository.js', () => ({
  findPasswordHash: mocks.findPasswordHash,
  saveDeletionToken: mocks.saveDeletionToken,
  consumeDeletionToken: mocks.consumeDeletionToken,
  scheduleDeletion: mocks.scheduleDeletion,
  cancelDeletion: mocks.cancelDeletion,
  findAccountsDueForDeletion: mocks.findAccountsDueForDeletion,
  purgeAccount: mocks.purgeAccount,
}));
vi.mock('../libs/authRateLimit.js', () => ({
  consumeQuota: mocks.consumeQuota,
  authFingerprint: (scope: string, kind: string, value: string) => `${scope}|${kind}|${value}`,
}));
vi.mock('../auth/auth.js', () => ({ verifyBetterAuthPassword: mocks.verifyBetterAuthPassword }));
vi.mock('../auth/email.js', () => ({
  sendAccountDeletionConfirmation: mocks.sendAccountDeletionConfirmation,
  sendAccountDeletionScheduled: mocks.sendAccountDeletionScheduled,
  sendAccountDeletionCancelled: mocks.sendAccountDeletionCancelled,
  sendAccountDeleted: mocks.sendAccountDeleted,
}));
vi.mock('../db/client.js', () => ({ getDb: vi.fn(() => ({})), closeDb: vi.fn() }));

import {
  ACCOUNT_DELETION_GRACE_DAYS,
  cancelAccountDeletion,
  confirmAccountDeletion,
  purgeAccountsDueForDeletion,
  requestAccountDeletion,
} from '../services/accountDeletion.service.js';

const USER = { userId: 'user-1', email: 'gestor@bompao.com.br' };
const HOUR = 60 * 60 * 1000;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PUBLIC_SITE_URL = 'https://feedback.exemplo.com';
  mocks.consumeQuota.mockResolvedValue({ allowed: true, retry: 1 });
  mocks.findPasswordHash.mockResolvedValue('$2a$10$hash');
  mocks.verifyBetterAuthPassword.mockResolvedValue(true);
});

describe('pedido de exclusão no Perfil', () => {
  it('com a senha certa, guarda só o hash do link e manda o link ao e-mail da conta', async () => {
    await requestAccountDeletion({ ...USER, password: 'Gato!Verde!Pulou', sessionCreatedAt: new Date(0) });

    const [userId, tokenHash, seconds] = mocks.saveDeletionToken.mock.calls[0]!;
    expect(userId).toBe('user-1');
    expect(seconds).toBe(3600);
    const [to, url] = mocks.sendAccountDeletionConfirmation.mock.calls[0]!;
    expect(to).toBe('gestor@bompao.com.br');
    const token = new URL(url).searchParams.get('token')!;
    expect(url).toMatch(/^https:\/\/feedback\.exemplo\.com\/conta\/excluir\?token=/);
    expect(tokenHash).toBe(sha256(token));
    expect(tokenHash).not.toContain(token);
  });

  it('senha errada não manda e-mail nenhum', async () => {
    mocks.verifyBetterAuthPassword.mockResolvedValue(false);
    await expect(
      requestAccountDeletion({ ...USER, password: 'errada', sessionCreatedAt: new Date() }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_password' });
    expect(mocks.saveDeletionToken).not.toHaveBeenCalled();
    expect(mocks.sendAccountDeletionConfirmation).not.toHaveBeenCalled();
  });

  it('quem tem senha precisa mandá-la, mesmo com a sessão recente', async () => {
    await expect(requestAccountDeletion({ ...USER, sessionCreatedAt: new Date() })).rejects.toMatchObject({
      status: 400,
      code: 'password_required',
    });
  });

  it('quem só entra pelo Google passa com uma entrada nas últimas 24 h', async () => {
    mocks.findPasswordHash.mockResolvedValue(null);
    await requestAccountDeletion({ ...USER, sessionCreatedAt: new Date(Date.now() - 23 * HOUR) });
    expect(mocks.sendAccountDeletionConfirmation).toHaveBeenCalledOnce();
  });

  it('quem só entra pelo Google com a sessão antiga precisa entrar de novo', async () => {
    mocks.findPasswordHash.mockResolvedValue(null);
    await expect(
      requestAccountDeletion({ ...USER, sessionCreatedAt: new Date(Date.now() - 25 * HOUR) }),
    ).rejects.toMatchObject({ status: 403, code: 'login_again' });
    expect(mocks.sendAccountDeletionConfirmation).not.toHaveBeenCalled();
  });

  it('para no limite de pedidos por hora antes de conferir a senha', async () => {
    mocks.consumeQuota.mockResolvedValue({ allowed: false, retry: 1200 });
    await expect(
      requestAccountDeletion({ ...USER, password: 'chute', sessionCreatedAt: new Date() }),
    ).rejects.toMatchObject({ status: 429, code: 'rate_limited', retryAfterSeconds: 1200 });
    expect(mocks.verifyBetterAuthPassword).not.toHaveBeenCalled();
    const [, key, limit, seconds] = mocks.consumeQuota.mock.calls[0]!;
    expect(key).toBe('account-deletion:email:account-deletion|email|gestor@bompao.com.br');
    expect([limit, seconds]).toEqual([5, 3600]);
  });
});

describe('confirmação pelo link do e-mail', () => {
  it('marca a exclusão para daqui a 15 dias e avisa por e-mail como desistir', async () => {
    const date = new Date('2026-12-06T12:00:00.000Z');
    mocks.consumeDeletionToken.mockResolvedValue(true);
    mocks.scheduleDeletion.mockResolvedValue(date);

    await expect(confirmAccountDeletion({ ...USER, token: 'tok' })).resolves.toBe(date);

    expect(mocks.consumeDeletionToken).toHaveBeenCalledWith('user-1', sha256('tok'));
    expect(mocks.scheduleDeletion).toHaveBeenCalledWith('user-1', ACCOUNT_DELETION_GRACE_DAYS);
    expect(ACCOUNT_DELETION_GRACE_DAYS).toBe(15);
    expect(mocks.sendAccountDeletionScheduled).toHaveBeenCalledWith(
      'gestor@bompao.com.br',
      date,
      'https://feedback.exemplo.com/login',
    );
  });

  it('link vencido, usado ou de outra conta não marca nada', async () => {
    mocks.consumeDeletionToken.mockResolvedValue(false);
    await expect(confirmAccountDeletion({ ...USER, token: 'tok' })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_deletion_link',
    });
    expect(mocks.scheduleDeletion).not.toHaveBeenCalled();
  });
});

describe('desistência', () => {
  it('cancela e avisa por e-mail', async () => {
    mocks.cancelDeletion.mockResolvedValue(true);
    await cancelAccountDeletion(USER);
    expect(mocks.sendAccountDeletionCancelled).toHaveBeenCalledWith('gestor@bompao.com.br');
  });

  it('sem exclusão marcada, responde 409 e não manda e-mail', async () => {
    mocks.cancelDeletion.mockResolvedValue(false);
    await expect(cancelAccountDeletion(USER)).rejects.toMatchObject({ status: 409, code: 'no_deletion_scheduled' });
    expect(mocks.sendAccountDeletionCancelled).not.toHaveBeenCalled();
  });
});

describe('rotina diária', () => {
  it('apaga as contas vencidas, avisa cada uma e não para numa falha', async () => {
    mocks.findAccountsDueForDeletion.mockResolvedValue(['a', 'b', 'c']);
    mocks.purgeAccount
      .mockResolvedValueOnce('a@x.com')
      .mockRejectedValueOnce(new Error('falhou'))
      .mockResolvedValueOnce(null);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(purgeAccountsDueForDeletion()).resolves.toEqual({ deleted: 1, failed: 1 });

    expect(mocks.purgeAccount).toHaveBeenCalledTimes(3);
    expect(mocks.sendAccountDeleted).toHaveBeenCalledOnce();
    expect(mocks.sendAccountDeleted).toHaveBeenCalledWith('a@x.com');
  });
});
