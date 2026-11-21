/**
 * "Excluir minha conta" (LGPD, art. 18) em três passos, para que nem um clique
 * distraído nem uma sessão roubada apaguem os dados na hora:
 *
 * 1. Pedido no Perfil: a senha (ou uma entrada recente, para quem só usa o Google)
 *    e um link de uso único enviado ao e-mail da conta.
 * 2. Confirmação pelo link, no navegador logado: a conta fica parada por 15 dias,
 *    todas as sessões caem e o formulário público deixa de receber respostas.
 * 3. Fim do prazo: a rotina diária apaga tudo. Até lá, quem entrar de novo pode desistir.
 */
import { createHash, randomBytes } from 'node:crypto';
import { verifyBetterAuthPassword } from '../auth/auth.js';
import { API_ERROR_RATE_LIMITED } from '../auth/errorMap.js';
import {
  sendAccountDeleted,
  sendAccountDeletionCancelled,
  sendAccountDeletionConfirmation,
  sendAccountDeletionScheduled,
} from '../auth/email.js';
import {
  API_ERROR_DELETION_ALREADY_SCHEDULED,
  API_ERROR_INVALID_DELETION_LINK,
  API_ERROR_INVALID_PASSWORD,
  API_ERROR_LOGIN_AGAIN,
  API_ERROR_NO_DELETION_SCHEDULED,
  API_ERROR_PASSWORD_REQUIRED,
} from '../config/errors.js';
import { getDb } from '../db/client.js';
import { authFingerprint, consumeQuota } from '../libs/authRateLimit.js';
import {
  cancelDeletion,
  consumeDeletionToken,
  findAccountsDueForDeletion,
  findPasswordHash,
  purgeAccount,
  saveDeletionToken,
  scheduleDeletion,
} from '../repositories/accountDeletion.repository.js';
import { describeError } from '../utils/describeError.js';

export const ACCOUNT_DELETION_GRACE_DAYS = 15;
const DELETION_LINK_VALID_SECONDS = 60 * 60;
/** Mesma janela do `freshAge` padrão do Better Auth. */
const FRESH_SESSION_MS = 24 * 60 * 60 * 1000;
/** Pedidos por conta por hora: segura quem tenta adivinhar a senha com a sessão roubada. */
const REQUESTS_PER_HOUR = 5;
const PURGE_BATCH_SIZE = 50;

export class AccountDeletionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = 'AccountDeletionError';
  }
}

function webBase(): string {
  return process.env.PUBLIC_SITE_URL ?? 'http://localhost:5173';
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function assertRequestQuota(email: string): Promise<void> {
  const key = `account-deletion:email:${authFingerprint('account-deletion', 'email', email.trim().toLowerCase())}`;
  const quota = await consumeQuota(getDb(), key, REQUESTS_PER_HOUR, 60 * 60);
  if (!quota.allowed) throw new AccountDeletionError(429, API_ERROR_RATE_LIMITED, quota.retry);
}

async function assertIdentity(userId: string, password: string | undefined, sessionCreatedAt: Date): Promise<void> {
  const passwordHash = await findPasswordHash(userId);
  if (!passwordHash) {
    if (Date.now() - sessionCreatedAt.getTime() >= FRESH_SESSION_MS) {
      throw new AccountDeletionError(403, API_ERROR_LOGIN_AGAIN);
    }
    return;
  }
  if (!password) throw new AccountDeletionError(400, API_ERROR_PASSWORD_REQUIRED);
  if (!(await verifyBetterAuthPassword(passwordHash, password))) {
    throw new AccountDeletionError(400, API_ERROR_INVALID_PASSWORD);
  }
}

/** Passo 1: confere quem pede e manda o link de confirmação ao e-mail da conta. */
export async function requestAccountDeletion(input: {
  userId: string;
  email: string;
  password?: string;
  sessionCreatedAt: Date;
}): Promise<void> {
  await assertRequestQuota(input.email);
  await assertIdentity(input.userId, input.password, input.sessionCreatedAt);

  const token = randomBytes(32).toString('base64url');
  await saveDeletionToken(input.userId, hashToken(token), DELETION_LINK_VALID_SECONDS);
  sendAccountDeletionConfirmation(input.email, `${webBase()}/conta/excluir?token=${encodeURIComponent(token)}`);
}

/** Passo 2: o link do e-mail, aberto no navegador logado, marca a data e derruba as sessões. */
export async function confirmAccountDeletion(input: { userId: string; email: string; token: string }): Promise<Date> {
  if (!(await consumeDeletionToken(input.userId, hashToken(input.token)))) {
    throw new AccountDeletionError(400, API_ERROR_INVALID_DELETION_LINK);
  }
  const scheduledFor = await scheduleDeletion(input.userId, ACCOUNT_DELETION_GRACE_DAYS);
  if (!scheduledFor) throw new AccountDeletionError(409, API_ERROR_DELETION_ALREADY_SCHEDULED);
  sendAccountDeletionScheduled(input.email, scheduledFor, `${webBase()}/login`);
  return scheduledFor;
}

/** Desistência, depois de entrar de novo com a senha ou o Google. */
export async function cancelAccountDeletion(input: { userId: string; email: string }): Promise<void> {
  if (!(await cancelDeletion(input.userId))) {
    throw new AccountDeletionError(409, API_ERROR_NO_DELETION_SCHEDULED);
  }
  sendAccountDeletionCancelled(input.email);
}

/** Passo 3, da rotina diária: apaga as contas com o prazo vencido, uma transação por conta. */
export async function purgeAccountsDueForDeletion(): Promise<{ deleted: number; failed: number }> {
  const userIds = await findAccountsDueForDeletion(PURGE_BATCH_SIZE);
  let deleted = 0;
  let failed = 0;
  for (const userId of userIds) {
    try {
      const email = await purgeAccount(userId);
      if (!email) continue;
      sendAccountDeleted(email);
      deleted++;
    } catch (error) {
      // Uma conta com falha não segura as outras: ela volta na próxima rodada.
      failed++;
      console.error('[account-deletion] falha ao apagar uma conta vencida:', describeError(error));
    }
  }
  return { deleted, failed };
}
