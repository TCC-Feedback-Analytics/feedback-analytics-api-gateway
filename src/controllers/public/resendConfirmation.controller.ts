import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import z from 'zod';
import { sendTypedError } from '../../utils/sendTypedError.js';
import { API_ERROR_INVALID_PAYLOAD } from '../../config/errors.js';
import { getAuth } from '../../auth/auth.js';
import { APIError } from 'better-auth/api';
import { fromNodeHeaders } from 'better-auth/node';
import { mapResendError } from '../../auth/errorMap.js';

const resendConfirmationSchema = z.object({
  email: z.email({ error: 'E-mail inválido' }),
});

const RESEND_ACCEPTED_MESSAGE =
  'Se existir uma conta pendente para este e-mail, enviaremos uma nova confirmação.';

function emailFingerprint(email: string) {
  return createHash('sha256').update(email).digest('hex').slice(0, 12);
}

function sendAcceptedResponse(res: Response) {
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, message: RESEND_ACCEPTED_MESSAGE });
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
  const parsed = resendConfirmationSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD, {
      issues: parsed.error.issues,
      message: 'Informe um e-mail válido para reenviar a confirmação.',
    });
  }

  const email = parsed.data.email.toLowerCase();
  const emailHash = emailFingerprint(email);

  const webBase = process.env.PUBLIC_SITE_URL ?? 'http://localhost:5173';
  try {
    await getAuth().api.sendVerificationEmail({
      body: { email, callbackURL: `${webBase}/auth/success` },
      headers: getAnonymousAuthHeaders(req),
    });
    return sendAcceptedResponse(res);
  } catch (err) {
    if (err instanceof APIError) {
      const mapped = mapResendError(err);

      if (mapped.http === 429) {
        return sendTypedError(res, mapped.http, mapped.code, { message: mapped.message });
      }

      console.warn(
        `[resend-confirmation] falha suprimida emailHash=${emailHash} code=${mapped.code} status=${mapped.http}`,
      );
      return sendAcceptedResponse(res);
    }

    const errorName = err instanceof Error ? err.name : typeof err;
    console.warn(
      `[resend-confirmation] falha suprimida emailHash=${emailHash} error=${errorName}`,
    );
    return sendAcceptedResponse(res);
  }
}
