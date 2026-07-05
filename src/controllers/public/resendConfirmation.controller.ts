import type { Request, Response } from 'express';
import z from 'zod';
import { sendTypedError } from '../../utils/sendTypedError.js';
import { API_ERROR_INTERNAL_ERROR, API_ERROR_INVALID_PAYLOAD } from '../../config/errors.js';
import { getAuth } from '../../auth/auth.js';
import { APIError } from 'better-auth/api';
import { mapResendError } from '../../auth/errorMap.js';

const resendConfirmationSchema = z.object({
  email: z.email({ error: 'E-mail inválido' }),
});

export async function resendConfirmationController(req: Request, res: Response) {
  const parsed = resendConfirmationSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD, {
      issues: parsed.error.issues,
      message: 'Informe um e-mail válido para reenviar a confirmação.',
    });
  }

  const { email } = parsed.data;

  const webBase = process.env.PUBLIC_SITE_URL ?? 'http://localhost:5173';
  try {
    await getAuth().api.sendVerificationEmail({
      body: { email, callbackURL: `${webBase}/auth/success` },
    });
    return res.json({ ok: true, message: 'E-mail de confirmação reenviado com sucesso.' });
  } catch (err) {
    if (err instanceof APIError) {
      const mapped = mapResendError(err);
      return sendTypedError(res, mapped.http, mapped.code, { message: mapped.message });
    }
    console.error('Resend confirmation error:', err);
    return sendTypedError(res, 500, API_ERROR_INTERNAL_ERROR, {
      message: 'Erro interno ao reenviar e-mail. Tente novamente.',
    });
  }
}
