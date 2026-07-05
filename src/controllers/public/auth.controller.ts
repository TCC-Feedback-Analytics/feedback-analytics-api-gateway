import type { Request, Response } from 'express';
import { loginSchema } from '@feedback/lib-shared/schemas/public/loginSchema';
import { createSupabaseServerClient } from '../../config/supabase.js';
import {
  API_ERROR_INTERNAL_ERROR,
  API_ERROR_INVALID_CREDENTIALS,
  API_ERROR_INVALID_PAYLOAD,
} from '../../config/errors.js';
import { sendTypedError } from '../../utils/sendTypedError.js';
import { fromNodeHeaders } from 'better-auth/node';
import { APIError } from 'better-auth/api';
import { isBetterAuth } from '../../config/authProvider.js';
import { getAuth } from '../../auth/auth.js';
import { mapLoginError } from '../../auth/errorMap.js';

type LoginEndpointErrorCode =
  | typeof API_ERROR_INVALID_PAYLOAD
  | typeof API_ERROR_INVALID_CREDENTIALS
  | typeof API_ERROR_INTERNAL_ERROR
  | 'rate_limited'
  | 'service_unavailable'
  | 'login_failed';

function mapSupabaseLoginError(error: { code?: string; message?: string }): {
  status: number;
  code: LoginEndpointErrorCode;
  message: string;
} {
  const message = error.message?.trim() ?? '';
  const msg = message.toLowerCase();

  // RNE-014 (Proteção contra Enumeração de Usuários): um e-mail cadastrado porém
  // não confirmado NÃO pode gerar uma resposta distinta da de credenciais
  // inválidas. Caso contrário, um atacante distinguiria contas existentes (mas
  // não verificadas) de e-mails inexistentes, viabilizando varredura de cadastros.
  // Por isso retornamos a MESMA resposta genérica de credenciais inválidas.
  if (
    error.code === 'email_not_confirmed' ||
    msg.includes('email not confirmed') ||
    msg.includes('email_not_confirmed')
  ) {
    return {
      status: 401,
      code: API_ERROR_INVALID_CREDENTIALS,
      message: 'E-mail ou senha incorretos. Revise as credenciais e tente novamente.',
    };
  }

  if (
    msg.includes('too many requests') ||
    msg.includes('rate limit') ||
    msg.includes('email rate limit exceeded')
  ) {
    return {
      status: 429,
      code: 'rate_limited',
      message: 'Muitas tentativas de login. Aguarde alguns instantes e tente novamente.',
    };
  }

  if (
    msg.includes('unable to validate email address') ||
    msg.includes('invalid email') ||
    msg.includes('email address is invalid')
  ) {
    return {
      status: 400,
      code: API_ERROR_INVALID_PAYLOAD,
      message: 'E-mail inválido. Verifique o formato informado.',
    };
  }

  if (
    msg.includes('service unavailable') ||
    msg.includes('temporarily unavailable') ||
    msg.includes('internal server error') ||
    msg.includes('unexpected failure')
  ) {
    return {
      status: 503,
      code: 'service_unavailable',
      message: 'Serviço de login temporariamente indisponível. Tente novamente em instantes.',
    };
  }

  if (
    error.code === 'invalid_credentials' ||
    error.code === 'invalid_grant' ||
    msg.includes('invalid login credentials') ||
    msg.includes('invalid credentials')
  ) {
    return {
      status: 401,
      code: API_ERROR_INVALID_CREDENTIALS,
      message: 'E-mail ou senha incorretos. Revise as credenciais e tente novamente.',
    };
  }

  return {
    status: 401,
    code: 'login_failed',
    message: message || 'Não foi possível realizar o login no momento.',
  };
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

    // --- Better Auth (gated) ---
    if (isBetterAuth()) {
      const remember = payload.remember === true || String(payload.remember) === 'true';
      try {
        const { headers, response } = await getAuth().api.signInEmail({
          body: { email: payload.email, password: payload.password, rememberMe: remember },
          returnHeaders: true,
        });
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
    }

    const supabase = createSupabaseServerClient(req, res, {
      remember: payload.remember ?? false,
    });

    const { data, error } = await supabase.auth.signInWithPassword({
      email: payload.email,
      password: payload.password,
    });

    if (error) {
      const mapped = mapSupabaseLoginError({
        code: error.code,
        message: error.message,
      });

      return sendTypedError(res, mapped.status, mapped.code, {
        message: mapped.message,
      });
    }

    return res.json({ ok: true, user: data.user ?? null });
  } catch (err) {
    console.error('Login endpoint error:', err);
    return sendTypedError(res, 500, API_ERROR_INTERNAL_ERROR, {
      message: 'Falha temporária ao processar login. Tente novamente.',
    });
  }
}

export async function logoutController(req: Request, res: Response) {
  try {
    // --- Better Auth (gated) ---
    if (isBetterAuth()) {
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
    }

    const supabase = createSupabaseServerClient(req, res);
    await supabase.auth.signOut({ scope: 'global' });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(204).end();
  } catch {
    return res.status(500).json({ ok: false });
  }
}
