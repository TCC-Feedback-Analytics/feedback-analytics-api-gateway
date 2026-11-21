import type { Request, Response } from 'express';
import { z } from 'zod';
import { API_ERROR_RATE_LIMITED } from '../../auth/errorMap.js';
import { API_ERROR_INTERNAL_SERVER_ERROR, API_ERROR_INVALID_PAYLOAD } from '../../config/errors.js';
import {
  AccountDeletionError,
  cancelAccountDeletion,
  confirmAccountDeletion,
  requestAccountDeletion,
} from '../../services/accountDeletion.service.js';
import { describeError } from '../../utils/describeError.js';
import { sendRateLimited } from '../../utils/sendRateLimited.js';
import { sendTypedError } from '../../utils/sendTypedError.js';

const REQUEST_LIMITED_MESSAGE = 'Muitos pedidos de exclusão. Aguarde e tente novamente.';

const requestSchema = z.object({ password: z.string().min(1).max(256).optional() });
const confirmSchema = z.object({ token: z.string().min(1).max(200) });

function sendDeletionError(res: Response, error: unknown, logTag: string) {
  if (error instanceof AccountDeletionError) {
    if (error.code === API_ERROR_RATE_LIMITED) {
      return sendRateLimited(res, error.retryAfterSeconds ?? 60, REQUEST_LIMITED_MESSAGE);
    }
    return sendTypedError(res, error.status, error.code);
  }
  console.error(`[account-deletion:${logTag}]`, describeError(error));
  return sendTypedError(res, 500, API_ERROR_INTERNAL_SERVER_ERROR);
}

/** POST /api/protected/user/account-deletion — confere a senha e manda o link ao e-mail. */
export async function requestAccountDeletionController(req: Request, res: Response) {
  const parsed = requestSchema.safeParse(req.body ?? {});
  if (!parsed.success || !req.user?.email) return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD);
  try {
    await requestAccountDeletion({
      userId: req.user.id,
      email: req.user.email,
      password: parsed.data.password,
      // Sem a data da sessão, ela não conta como recente.
      sessionCreatedAt: req.sessionCreatedAt ?? new Date(0),
    });
    return res.status(202).json({ status: 'email_sent' });
  } catch (error) {
    return sendDeletionError(res, error, 'request');
  }
}

/** POST /api/protected/user/account-deletion/confirm — o link do e-mail: começa a carência. */
export async function confirmAccountDeletionController(req: Request, res: Response) {
  const parsed = confirmSchema.safeParse(req.body ?? {});
  if (!parsed.success || !req.user?.email) return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD);
  try {
    const scheduledFor = await confirmAccountDeletion({
      userId: req.user.id,
      email: req.user.email,
      token: parsed.data.token,
    });
    return res.json({ deletion_scheduled_for: scheduledFor.toISOString() });
  } catch (error) {
    return sendDeletionError(res, error, 'confirm');
  }
}

/** POST /api/protected/user/account-deletion/cancel — desistência, depois de entrar de novo. */
export async function cancelAccountDeletionController(req: Request, res: Response) {
  if (!req.user?.email) return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD);
  try {
    await cancelAccountDeletion({ userId: req.user.id, email: req.user.email });
    return res.json({ ok: true });
  } catch (error) {
    return sendDeletionError(res, error, 'cancel');
  }
}
