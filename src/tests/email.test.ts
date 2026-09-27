import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendMail: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({ sendMail: mocks.sendMail }),
  },
}));

vi.mock('@vercel/functions', () => ({
  waitUntil: mocks.waitUntil,
}));

import { sendVerificationEmail } from '../auth/email.js';

describe('envio de e-mail na Vercel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('VERCEL', '1');
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('mantém a Function viva até o Nodemailer concluir', async () => {
    mocks.sendMail.mockResolvedValue({ messageId: 'sendgrid-message-id' });

    sendVerificationEmail('pessoa@empresa.com', 'https://web.test/auth/success');

    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    const delivery = mocks.waitUntil.mock.calls[0]?.[0] as Promise<void>;
    await delivery;

    expect(mocks.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'pessoa@empresa.com',
        subject: 'Confirme seu e-mail',
      }),
    );
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('messageId=sendgrid-message-id'),
    );
  });

  it('registra a falha SMTP sem rejeitar a tarefa em background', async () => {
    mocks.sendMail.mockRejectedValue(new Error('SMTP indisponível'));

    sendVerificationEmail('pessoa@empresa.com', 'https://web.test/auth/success');

    const delivery = mocks.waitUntil.mock.calls[0]?.[0] as Promise<void>;
    await expect(delivery).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('SMTP indisponível'),
    );
  });
});
