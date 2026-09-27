/**
 * Provider de e-mail transacional (nodemailer via SMTP), escolhido por env:
 *  - DEV/local: Mailpit (`SMTP_HOST=127.0.0.1`, `SMTP_PORT=1025`, sem auth/TLS) —
 *    captura o e-mail para inspeção em http://localhost:8025, sem envio real.
 *  - PROD: SMTP do Resend (`smtp.resend.com`, `SMTP_USER=resend`, `SMTP_PASS=<API key>`,
 *    `SMTP_SECURE=true`) ou qualquer SMTP corporativo. Mesmo caminho de código.
 *
 * Na Vercel, os disparos são registrados com `waitUntil` para que a Function
 * continue viva até o SMTP concluir, sem bloquear a resposta HTTP. Localmente,
 * o servidor é persistente e a Promise pode continuar em background.
 */
import { createHash } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import nodemailer, { type Transporter } from 'nodemailer';

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST ?? '127.0.0.1';
  const port = Number(process.env.SMTP_PORT ?? 1025);
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const secure = String(process.env.SMTP_SECURE ?? '').trim() === 'true';

  transporter = nodemailer.createTransport({
    host,
    port,
    secure, // true para 465 (Resend TLS); false para Mailpit :1025
    ...(user && pass ? { auth: { user, pass } } : {}),
    // Mailpit local não fala TLS; sem credenciais evitamos o STARTTLS opcional.
    ...(!secure && !user ? { ignoreTLS: true } : {}),
  });
  return transporter;
}

const MAIL_FROM =
  process.env.MAIL_FROM ?? 'Feedback Analytics <no-reply@feedback.local>';

function recipientFingerprint(to: string) {
  return createHash('sha256').update(to.toLowerCase()).digest('hex').slice(0, 12);
}

function send(to: string, subject: string, text: string, html: string): void {
  const recipientHash = recipientFingerprint(to);
  const delivery = getTransporter()
    .sendMail({ from: MAIL_FROM, to, subject, text, html })
    .then((info) => {
      console.info(
        `[email] enviado "${subject}" recipientHash=${recipientHash} messageId=${info.messageId}`,
      );
    })
    .catch((err: unknown) => {
      const message =
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message?: unknown }).message)
          : String(err);
      console.warn(
        `[email] falha ao enviar "${subject}" recipientHash=${recipientHash}: ${message}`,
      );
    });

  if (process.env.VERCEL === '1') {
    waitUntil(delivery);
    return;
  }

  void delivery;
}

/** E-mail de confirmação de cadastro (link do Better Auth). */
export function sendVerificationEmail(to: string, url: string): void {
  send(
    to,
    'Confirme seu e-mail',
    `Confirme seu cadastro acessando: ${url}`,
    `<p>Bem-vindo(a)! Confirme seu cadastro clicando no link abaixo:</p>
     <p><a href="${url}">Confirmar meu e-mail</a></p>
     <p>Se você não criou esta conta, ignore este e-mail.</p>`,
  );
}

/** E-mail de redefinição de senha (link do Better Auth). */
export function sendResetPasswordEmail(to: string, url: string): void {
  send(
    to,
    'Redefinir sua senha',
    `Redefina sua senha acessando: ${url}`,
    `<p>Recebemos um pedido para redefinir sua senha.</p>
     <p><a href="${url}">Redefinir minha senha</a></p>
     <p>Se não foi você, ignore este e-mail — sua senha continua a mesma.</p>`,
  );
}
