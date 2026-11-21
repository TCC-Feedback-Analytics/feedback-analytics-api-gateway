import { vi, describe, it, expect, beforeEach } from 'vitest';

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail }) } }));

import { withChangeEmailStep } from '../auth/auth.js';
import { sendChangeEmailApproval, formatDateBr } from '../auth/email.js';

beforeEach(() => {
  vi.clearAllMocks();
  sendMail.mockResolvedValue({ messageId: 'm-1' });
});

describe('troca de e-mail em dois passos', () => {
  const link =
    'https://api.exemplo.com/api/auth/verify-email?token=tok&callbackURL=' +
    encodeURIComponent('https://feedback.exemplo.com/auth/success');

  it('cada link volta para a Web dizendo em que passo a pessoa está', () => {
    const approval = new URL(withChangeEmailStep(link, 'troca-aprovada'));
    expect(approval.searchParams.get('token')).toBe('tok');
    expect(approval.searchParams.get('callbackURL')).toBe('https://feedback.exemplo.com/auth/success?tipo=troca-aprovada');

    const verification = new URL(withChangeEmailStep(approval.toString(), 'email-trocado'));
    expect(verification.searchParams.get('callbackURL')).toBe('https://feedback.exemplo.com/auth/success?tipo=email-trocado');
  });

  it('sem destino absoluto, deixa o link como veio', () => {
    const relative = 'https://api.exemplo.com/api/auth/verify-email?token=tok&callbackURL=%2F';
    expect(withChangeEmailStep(relative, 'troca-aprovada')).toBe(relative);
  });

  it('o pedido de aprovação vai para o endereço atual, com o novo escapado no HTML', () => {
    sendChangeEmailApproval('atual@bompao.com.br', '<b>novo</b>@x.com', 'https://link');

    const mail = sendMail.mock.calls[0]![0] as { to: string; html: string; subject: string };
    expect(mail.to).toBe('atual@bompao.com.br');
    expect(mail.subject).toBe('Aprove a troca do e-mail da sua conta');
    expect(mail.html).toContain('&lt;b&gt;novo&lt;/b&gt;@x.com');
    expect(mail.html).not.toContain('<b>novo</b>');
  });

  it('a data dos avisos sai no fuso de Brasília', () => {
    expect(formatDateBr(new Date('2026-12-06T02:00:00.000Z'))).toBe('05/12/2026');
  });
});
