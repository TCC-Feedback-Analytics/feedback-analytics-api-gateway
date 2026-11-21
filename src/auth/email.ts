/**
 * Provider de e-mail transacional (nodemailer via SMTP), escolhido por env:
 *  - DEV/local: Mailpit (`SMTP_HOST=127.0.0.1`, `SMTP_PORT=1025`, sem auth/TLS) —
 *    captura o e-mail para inspeção em http://localhost:8025, sem envio real.
 *  - PROD: SMTP da Brevo (`smtp-relay.brevo.com`, `SMTP_PORT=587`, `SMTP_SECURE=false`,
 *    `SMTP_USER=<login SMTP>`, `SMTP_PASS=<chave SMTP, não a API key>`) ou qualquer
 *    outro SMTP. Mesmo caminho de código.
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

/** O endereço novo é digitado por quem pediu a troca: entra no HTML só escapado. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Data no fuso de Brasília, como o gestor lê: 05/12/2026. */
export function formatDateBr(date: Date): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(date);
}

/**
 * Troca de e-mail, primeiro passo: vai para o endereço ATUAL. Só depois da aprovação
 * o link de confirmação segue para o endereço novo. Assim, quem tem só a sessão
 * roubada não consegue levar a conta para um e-mail dele.
 */
export function sendChangeEmailApproval(to: string, newEmail: string, url: string): void {
  send(
    to,
    'Aprove a troca do e-mail da sua conta',
    `Pediram para trocar o e-mail da sua conta para ${newEmail}. Para aprovar, acesse: ${url}. Se não foi você, ignore este e-mail e troque a sua senha.`,
    `<p>Pediram para trocar o e-mail da sua conta para <strong>${escapeHtml(newEmail)}</strong>.</p>
     <p><a href="${url}">Aprovar a troca</a></p>
     <p>Depois da aprovação, enviamos um link para o endereço novo, e a troca só vale quando ele for confirmado.</p>
     <p>Se não foi você, ignore este e-mail e troque a sua senha: a conta continua com este endereço.</p>`,
  );
}

/** Exclusão da conta, primeiro passo: o link que confirma o pedido feito no Perfil. */
export function sendAccountDeletionConfirmation(to: string, url: string): void {
  send(
    to,
    'Confirme a exclusão da sua conta',
    `Recebemos um pedido para excluir a sua conta. Para confirmar, acesse: ${url}. O link vale 1 hora e precisa ser aberto no navegador em que você está logado. Se não foi você, ignore este e-mail e troque a sua senha.`,
    `<p>Recebemos um pedido para excluir a sua conta no Feedback Analytics.</p>
     <p><a href="${url}">Confirmar a exclusão</a></p>
     <p>O link vale 1 hora e precisa ser aberto no navegador em que você está logado.
        Depois da confirmação, a conta fica parada por 15 dias e só então é apagada.</p>
     <p>Se não foi você, ignore este e-mail e troque a sua senha: nada será apagado.</p>`,
  );
}

/** Exclusão confirmada: a data em que tudo será apagado e como desistir. */
export function sendAccountDeletionScheduled(to: string, deletionDate: Date, loginUrl: string): void {
  const day = formatDateBr(deletionDate);
  send(
    to,
    `Sua conta será excluída em ${day}`,
    `A exclusão da sua conta foi confirmada. Ela está parada e será apagada em ${day}, com todos os dados. Para desistir, entre na conta até lá: ${loginUrl}`,
    `<p>A exclusão da sua conta foi confirmada.</p>
     <p>A conta está parada: o painel fica fechado e os QR Codes, links e etiquetas NFC não recebem respostas.
        Em <strong>${day}</strong>, a conta, a empresa e todos os dados dela serão apagados.</p>
     <p>Mudou de ideia? <a href="${loginUrl}">Entre na sua conta</a> até lá e escolha "Cancelar exclusão".</p>`,
  );
}

/** Exclusão cancelada pelo gestor, depois de entrar de novo. */
export function sendAccountDeletionCancelled(to: string): void {
  send(
    to,
    'A exclusão da sua conta foi cancelada',
    'A exclusão da sua conta foi cancelada. Tudo voltou a funcionar como antes. Se não foi você, troque a sua senha.',
    `<p>A exclusão da sua conta foi cancelada. O painel, os QR Codes, os links e as etiquetas NFC voltaram a funcionar.</p>
     <p>Se não foi você, troque a sua senha.</p>`,
  );
}

/** Fim do prazo: a conta e os dados foram apagados. */
export function sendAccountDeleted(to: string): void {
  send(
    to,
    'Sua conta foi excluída',
    'Como pedido, a sua conta, a empresa e todos os dados dela foram apagados do Feedback Analytics.',
    `<p>Como pedido, a sua conta, a empresa e todos os dados dela foram apagados do Feedback Analytics.</p>
     <p>Obrigado por ter usado o sistema.</p>`,
  );
}

/** E-mail de confirmação do endereço novo, na troca de e-mail do Perfil (link do Better Auth). */
export function sendChangeEmailVerification(to: string, url: string): void {
  send(
    to,
    'Confirme seu novo e-mail',
    `Confirme a troca do e-mail da sua conta acessando: ${url}`,
    `<p>Recebemos um pedido para usar este endereço na sua conta.</p>
     <p><a href="${url}">Confirmar meu novo e-mail</a></p>
     <p>Se não foi você, ignore este e-mail — sua conta continua com o e-mail de antes.</p>`,
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
