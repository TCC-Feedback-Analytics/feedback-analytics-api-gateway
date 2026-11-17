import type { Request, Response } from 'express';
import { loginSchema } from '@feedback/lib-shared/schemas/public/loginSchema';
import { API_ERROR_INTERNAL_ERROR, API_ERROR_INVALID_PAYLOAD } from '../../config/errors.js';
import { sendTypedError } from '../../utils/sendTypedError.js';
import { fromNodeHeaders } from 'better-auth/node';
import { APIError } from 'better-auth/api';
import { getAuth } from '../../auth/auth.js';
import { mapLoginError } from '../../auth/errorMap.js';
import { describeError } from '../../utils/describeError.js';
import { authClientIp, releaseAuthAttempt, reserveAuthAttempt } from '../../libs/authRateLimit.js';
import { sendRateLimited } from '../../utils/sendRateLimited.js';

const LOGIN_LIMITED_MESSAGE = 'Muitas tentativas de login. Aguarde alguns minutos e tente novamente.';

/** Quem acertou a senha devolve a vaga: o limite conta só as tentativas que falham. */
async function forgiveSuccessfulLogin(ip: string, email: string): Promise<void> {
  try {
    await releaseAuthAttempt('login', ip, email);
  } catch (err) {
    console.warn('[login] não foi possível devolver a tentativa:', describeError(err));
  }
}

export async function loginController(req: Request, res: Response) {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD, {
        issues: parsed.error.issues,
        message: 'Dados de login inválidos.',
      });
    }

    const payload = parsed.data;
    const remember = payload.remember === true || String(payload.remember) === 'true';

    const ip = authClientIp(req);
    const reservation = await reserveAuthAttempt('login', ip, payload.email);
    if (!reservation.allowed) {
      return sendRateLimited(res, reservation.retryAfterSeconds, LOGIN_LIMITED_MESSAGE);
    }

    try {
      // Os cabeçalhos dão à sessão o IP e o navegador de quem entrou.
      const { headers, response } = await getAuth().api.signInEmail({
        body: { email: payload.email, password: payload.password, rememberMe: remember },
        headers: fromNodeHeaders(req.headers),
        returnHeaders: true,
      });
      await forgiveSuccessfulLogin(ip, payload.email);
      headers.getSetCookie().forEach((cookie) => res.appendHeader('set-cookie', cookie));
      const user = response?.user as { id: string; email: string } | undefined;
      return res.json({ ok: true, user: user ? { id: user.id, email: user.email } : null });
    } catch (err) {
      if (err instanceof APIError) {
        const mapped = mapLoginError(err);
        return sendTypedError(res, mapped.http, mapped.code, { message: mapped.message });
      }
      throw err; // erro inesperado → catch externo → 500
    }
  } catch (err) {
    console.error('Login endpoint error:', describeError(err));
    return sendTypedError(res, 500, API_ERROR_INTERNAL_ERROR, {
      message: 'Falha temporária ao processar login. Tente novamente.',
    });
  }
}

export async function logoutController(req: Request, res: Response) {
  try {
    try {
      const { headers } = await getAuth().api.signOut({
        headers: fromNodeHeaders(req.headers),
        returnHeaders: true,
      });
      headers.getSetCookie().forEach((cookie) => res.appendHeader('set-cookie', cookie));
    } catch {
      // Logout é idempotente: sessão ausente/inválida não deve falhar.
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(204).end();
  } catch {
    return res.status(500).json({ ok: false });
  }
}
