import type { Request, Response } from 'express';
import z from 'zod';
import { sendTypedError } from '../../utils/sendTypedError.js';
import { API_ERROR_INVALID_PAYLOAD } from '../../config/errors.js';
import { getAuth } from '../../auth/auth.js';
import { describeError } from '../../utils/describeError.js';
import { API_ERROR_SERVICE_UNAVAILABLE } from '../../auth/errorMap.js';
import { authClientIp, reserveAuthAttempt } from '../../libs/authRateLimit.js';
import { sendRateLimited } from '../../utils/sendRateLimited.js';

const FORGOT_PASSWORD_LIMITED_MESSAGE = 'Muitos pedidos de nova senha. Aguarde e tente novamente.';

const forgotPasswordSchema = z.object({
  email: z.email({ error: 'E-mail inválido' }),
});

export async function forgotPasswordController(req: Request, res: Response) {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD, {
      issues: parsed.error.issues,
      message: 'Informe um e-mail válido.',
    });
  }

  const { email } = parsed.data;

  // Conta todo pedido, exista o e-mail ou não: o 429 não revela quem tem conta.
  try {
    const reservation = await reserveAuthAttempt('forgot-password', authClientIp(req), email);
    if (!reservation.allowed) {
      return sendRateLimited(res, reservation.retryAfterSeconds, FORGOT_PASSWORD_LIMITED_MESSAGE);
    }
  } catch (err) {
    console.warn('[forgot-password] controle de pedidos indisponível:', describeError(err));
    return sendTypedError(res, 503, API_ERROR_SERVICE_UNAVAILABLE, {
      message: 'Não foi possível processar a solicitação. Tente novamente mais tarde.',
    });
  }

  const apiBase = process.env.BETTER_AUTH_URL ?? `${req.protocol}://${req.get('host')}`;
  try {
    await getAuth().api.requestPasswordReset({
      body: {
        email,
        redirectTo: `${apiBase}/api/public/auth/callback?type=recovery&next=/auth/reset-password`,
      },
    });
  } catch (err) {
    // Anti-enumeração: nunca revela se o e-mail existe; apenas registra.
    console.warn('[forgot-password]', describeError(err));
  }

  return res.json({
    ok: true,
    message: 'Se este e-mail estiver cadastrado, você receberá as instruções em breve.',
  });
}
