import type { Request, Response } from 'express';
import z from 'zod';
import { sendTypedError } from '../../utils/sendTypedError.js';
import { API_ERROR_INVALID_PAYLOAD } from '../../config/errors.js';
import { getAuth } from '../../auth/auth.js';
import { APIError } from 'better-auth/api';
import { fromNodeHeaders } from 'better-auth/node';
import { mapResendError } from '../../auth/errorMap.js';
import { reserveResend, resendClientIp, resendFingerprint } from '../../libs/resendRateLimit.js';

const resendConfirmationSchema = z.object({
  email: z.string().trim().pipe(z.email({ error: 'E-mail inválido' })),
});

const RESEND_ACCEPTED_MESSAGE =
  'Se existir uma conta pendente para este e-mail, enviaremos uma nova confirmação.';

function sendAcceptedResponse(res: Response, retryAfterSeconds: number) {
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, message: RESEND_ACCEPTED_MESSAGE, retryAfterSeconds });
}

function sendLimitedResponse(res: Response, retryAfterSeconds: number) {
  res.setHeader('Retry-After', String(retryAfterSeconds));
  return sendTypedError(res, 429, 'rate_limited', {
    message: 'Aguarde antes de solicitar outra confirmação.',
    retryAfterSeconds,
  });
}

function getAnonymousAuthHeaders(req: Request) {
  const headers = fromNodeHeaders(req.headers);

  // Mantém os dados de rede usados pelo rate limit, mas força o fluxo anônimo
  // para que a resposta não revele o estado da conta por meio da sessão.
  headers.delete('cookie');
  headers.delete('authorization');

  return headers;
}

export async function resendConfirmationController(req: Request, res: Response) {
  res.setHeader('Cache-Control', 'no-store');
  const parsed = resendConfirmationSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD, {
      issues: parsed.error.issues,
      message: 'Informe um e-mail válido para reenviar a confirmação.',
    });
  }

  const email = parsed.data.email.toLowerCase();
  let retryAfterSeconds: number;
  let emailHash: string;
  try {
    const reservation = await reserveResend(resendClientIp(req), email);
    if (!reservation.allowed) return sendLimitedResponse(res, reservation.retryAfterSeconds);
    retryAfterSeconds = reservation.retryAfterSeconds;
    emailHash = resendFingerprint('email', email);
  } catch {
    console.warn('[resend-confirmation] controle de reenvio indisponível');
    return sendTypedError(res, 503, 'service_unavailable', {
      message: 'Não foi possível processar a solicitação. Tente novamente mais tarde.',
    });
  }

  const webBase = process.env.PUBLIC_SITE_URL ?? 'http://localhost:5173';
  try {
    await getAuth().api.sendVerificationEmail({
      body: { email, callbackURL: `${webBase}/auth/success` },
      headers: getAnonymousAuthHeaders(req),
    });
    return sendAcceptedResponse(res, retryAfterSeconds);
  } catch (err) {
    if (err instanceof APIError) {
      const mapped = mapResendError(err);

      if (mapped.http === 429) {
        return sendLimitedResponse(res, retryAfterSeconds);
      }

      console.warn(
        `[resend-confirmation] falha suprimida emailHash=${emailHash} code=${mapped.code} status=${mapped.http}`,
      );
      return sendAcceptedResponse(res, retryAfterSeconds);
    }

    const errorName = err instanceof Error ? err.name : typeof err;
    console.warn(
      `[resend-confirmation] falha suprimida emailHash=${emailHash} error=${errorName}`,
    );
    return sendAcceptedResponse(res, retryAfterSeconds);
  }
}
