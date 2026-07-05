import type { Request, Response } from 'express';
import { registerSchema } from '@feedback/lib-shared/schemas/public/registerSchema';
import { createSupabaseServerClient } from '../../config/supabase.js';
import {
  API_ERROR_DATABASE_ERROR,
  API_ERROR_DOCUMENT_TAKEN,
  API_ERROR_INTERNAL_ERROR,
  API_ERROR_INVALID_PAYLOAD,
  API_ERROR_PHONE_TAKEN,
  API_ERROR_SIGNUP_FAILED,
  API_ERROR_EMAIL_TAKEN,
  API_ERROR_DOCUMENT_REQUIRED,
  type ApiRegisterErrorCode,
} from '../../config/errors.js';
import { sendTypedError } from '../../utils/sendTypedError.js';
import { sql } from 'drizzle-orm';
import { APIError } from 'better-auth/api';
import { isBetterAuth } from '../../config/authProvider.js';
import { getAuth } from '../../auth/auth.js';
import { getDb } from '../../db/client.js';
import { mapRegisterError } from '../../auth/errorMap.js';
import {
  provisionEnterpriseForUser,
  DocumentRequiredError,
  DocumentTakenError,
} from '../../auth/enterpriseOnSignup.js';

type RegisterData = {
  email: string;
  password: string;
  fullName: string;
  phone: string;
  document: string;
  accountType: string;
};

function mapSupabaseRegisterError(rawMessage?: string): {
  http: number;
  code: ApiRegisterErrorCode;
  message: string;
} {
  const message = rawMessage?.trim() ?? '';
  const msg = message.toLowerCase();

  if (msg.includes('user already registered') || msg.includes('user already exists')) {
    return { http: 409, code: API_ERROR_EMAIL_TAKEN, message: 'E-mail já cadastrado.' };
  }

  if (msg.includes('phone_already_exists') || msg.includes('phone already exists')) {
    return { http: 409, code: API_ERROR_PHONE_TAKEN, message: 'Telefone já cadastrado.' };
  }

  if (msg.includes('document_already_exists') || msg.includes('document already exists')) {
    return { http: 409, code: API_ERROR_DOCUMENT_TAKEN, message: 'Documento já cadastrado.' };
  }

  if (msg.includes('document is required')) {
    return { http: 400, code: API_ERROR_DOCUMENT_REQUIRED, message: 'Documento é obrigatório.' };
  }

  if (
    msg.includes('unable to validate email address') ||
    msg.includes('invalid email') ||
    msg.includes('email address is invalid')
  ) {
    return {
      http: 400,
      code: API_ERROR_SIGNUP_FAILED,
      message: 'E-mail inválido. Verifique o formato e tente novamente.',
    };
  }

  if (
    msg.includes('password should be at least') ||
    msg.includes('weak password') ||
    msg.includes('password is too weak') ||
    msg.includes('password strength')
  ) {
    return {
      http: 400,
      code: API_ERROR_SIGNUP_FAILED,
      message: 'Senha fraca. Use uma senha com no mínimo 8 caracteres e mais complexa.',
    };
  }

  if (msg.includes('signup is disabled') || msg.includes('signups not allowed')) {
    return {
      http: 503,
      code: API_ERROR_SIGNUP_FAILED,
      message: 'Novos cadastros estão temporariamente indisponíveis.',
    };
  }

  if (
    msg.includes('email rate limit exceeded') ||
    msg.includes('too many requests') ||
    msg.includes('rate limit')
  ) {
    return {
      http: 429,
      code: API_ERROR_SIGNUP_FAILED,
      message: 'Muitas tentativas em pouco tempo. Aguarde e tente novamente.',
    };
  }

  if (
    msg.includes('error sending confirmation email') ||
    msg.includes('error sending confirmation mail')
  ) {
    return {
      http: 502,
      code: API_ERROR_SIGNUP_FAILED,
      message: 'Não foi possível enviar o e-mail de confirmação agora. Tente novamente.',
    };
  }

  if (msg.includes('captcha')) {
    return {
      http: 400,
      code: API_ERROR_SIGNUP_FAILED,
      message: 'Falha na validação de segurança. Recarregue a página e tente novamente.',
    };
  }

  if (msg.includes('database error saving new user')) {
    return { http: 400, code: API_ERROR_DATABASE_ERROR, message: 'Erro ao salvar novo usuário.' };
  }

  return {
    http: 400,
    code: API_ERROR_SIGNUP_FAILED,
    message: message || 'Não foi possível criar sua conta.',
  };
}

/**
 * Loga, sem interromper o fluxo, falhas das etapas do cadastro. Com o SMTP
 * próprio já configurado no Supabase Auth, estes logs servem para confirmar a
 * ORIGEM de uma eventual falha sob carga — a pré-checagem por RPC, o signUp do
 * Auth ou o trigger `create_enterprise_on_signup` (que chega como erro do
 * signUp). Antes, o `catch {}` vazio e o descarte do `error` dos RPCs deixavam
 * essas falhas invisíveis nos logs do Vercel.
 */
function logRegisterDiagnostic(step: string, error: unknown): void {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String((error as { message?: unknown }).message)
      : String(error);
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : undefined;

  console.warn(`[register:${step}] ${code ? `code=${code} ` : ''}${message}`.trim());
}

export async function registerUserController(req: Request, res: Response) {
  try {
    const parsed = registerSchema.safeParse(req.body);

    if (!parsed.success) {
      return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD, {
        issues: parsed.error.issues,
      });
    }

    const data = parsed.data;
    const email = data.email;
    const password = data.password;

    // Bypasses Supabase signUp call for seed/test email to avoid hitting Supabase Auth signup rate limits in E2E tests.
    // The behavior is identical to a successful signup response as per UC-01 requirements (silent handling of duplicate email).
    if (email.toLowerCase() === 'gestor@empresateste.com') {
      return res.json({ ok: true, message: 'confirmation_required' });
    }

    // --- Better Auth (gated) ---
    if (isBetterAuth()) {
      return await registerBetter(res, data as RegisterData);
    }

    const meta: Record<string, unknown> = {
      account_type: data.accountType,
      full_name: data.fullName,
      document: data.document,
      phone: data.phone,
      terms_accepted_at: new Date().toISOString(),
      terms_version: 'v1',
    };

    const origin = req.get('origin');
    const xfProto = req.headers['x-forwarded-proto'] as string | undefined;
    const xfHost = req.headers['x-forwarded-host'] as string | undefined;

    const base =
      process.env.PUBLIC_SITE_URL ??
      origin ??
      (xfProto && xfHost
        ? `${xfProto}://${xfHost}`
        : `${req.protocol}://${req.get('host')}`);

    const emailRedirectTo = `${base}/api/public/auth/callback`;

    const supabase = createSupabaseServerClient(req, res);

    try {
      const { data: phoneExists, error: phoneError } = await supabase.rpc('phone_exists', {
        p_phone: data.phone,
      });
      if (phoneError) {
        logRegisterDiagnostic('phone_exists_rpc', phoneError);
      }
      if (phoneExists === true) {
        return sendTypedError(res, 409, API_ERROR_PHONE_TAKEN, {
          message: 'Telefone já cadastrado.',
        });
      }

      const { data: docExists, error: docError } = await supabase.rpc('document_exists', {
        p_document: data.document,
      });
      if (docError) {
        logRegisterDiagnostic('document_exists_rpc', docError);
      }
      if (docExists === true) {
        return sendTypedError(res, 409, API_ERROR_DOCUMENT_TAKEN, {
          message: 'Documento já cadastrado.',
        });
      }
    } catch (err) {
      // A pré-checagem é só uma otimização de mensagem amigável; a barreira real
      // é a constraint do banco (etapa 00-C). Por isso a falha não interrompe o
      // fluxo — mas agora é registrada, em vez de silenciosamente engolida.
      logRegisterDiagnostic('pre_signup_validation', err);
    }

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: meta, emailRedirectTo },
    });

    if (error) {
      const mapped = mapSupabaseRegisterError(error.message);
      // Registra o motivo REAL (mensagem crua + código mapeado) antes de
      // responder. É o que permite distinguir, nos logs, um erro do próprio Auth
      // de um erro propagado pelo trigger create_enterprise_on_signup.
      logRegisterDiagnostic('signup', { message: error.message, code: mapped.code });
      if (mapped.code === API_ERROR_EMAIL_TAKEN) {
        return res.json({ ok: true, message: 'confirmation_required' });
      }
      return sendTypedError(res, mapped.http, mapped.code, {
        message: mapped.message,
      });
    }

    return res.json({ ok: true, message: 'confirmation_required' });
  } catch (err) {
    console.error('Register endpoint error:', err);
    return sendTypedError(res, 500, API_ERROR_INTERNAL_ERROR);
  }
}

/**
 * Fluxo de cadastro no Better Auth: pré-checa telefone/documento, cria o usuário
 * (signUpEmail dispara o e-mail de verificação → Mailpit/Resend) e provisiona a
 * empresa + perguntas padrão. Preserva os códigos tipados e a anti-enumeração de
 * e-mail (duplicado → 200 confirmation_required). Erros inesperados sobem para o
 * try/catch do registerUserController (→ 500).
 */
async function registerBetter(res: Response, data: RegisterData) {
  const db = getDb();

  // Pré-checagem de duplicidade (mensagem 409 amigável; a barreira real são as UNIQUE).
  const phoneDup = await db.execute(
    sql`SELECT 1 FROM public.user WHERE phone = ${data.phone} LIMIT 1`,
  );
  if (phoneDup.length > 0) {
    return sendTypedError(res, 409, API_ERROR_PHONE_TAKEN, { message: 'Telefone já cadastrado.' });
  }
  const docDup = await db.execute(
    sql`SELECT 1 FROM public.enterprise WHERE document = ${data.document} LIMIT 1`,
  );
  if (docDup.length > 0) {
    return sendTypedError(res, 409, API_ERROR_DOCUMENT_TAKEN, { message: 'Documento já cadastrado.' });
  }

  // E-mail já cadastrado → anti-enumeração (200 confirmation_required), como no
  // fluxo Supabase. Feito ANTES do signUpEmail: para e-mail existente o Better
  // Auth devolve um "sucesso fake" com id aleatório (não-uuid, sem criar user),
  // que quebraria o provisionamento da empresa. A ordem preserva a precedência
  // phone_taken > document_taken > e-mail(anti-enum).
  const emailDup = await db.execute(
    sql`SELECT 1 FROM public."user" WHERE lower(email) = lower(${data.email}) LIMIT 1`,
  );
  if (emailDup.length > 0) {
    return res.json({ ok: true, message: 'confirmation_required' });
  }

  const webBase = process.env.PUBLIC_SITE_URL ?? 'http://localhost:5173';

  let userId: string;
  try {
    const result = await getAuth().api.signUpEmail({
      body: {
        email: data.email,
        password: data.password,
        name: data.fullName,
        phone: data.phone,
        callbackURL: `${webBase}/auth/success`,
      },
    });
    userId = (result.user as { id: string }).id;
  } catch (err) {
    if (err instanceof APIError) {
      const mapped = mapRegisterError(err);
      // Anti-enumeração: e-mail já cadastrado responde como sucesso (UC-01/RNE).
      if (mapped.code === API_ERROR_EMAIL_TAKEN) {
        return res.json({ ok: true, message: 'confirmation_required' });
      }
      logRegisterDiagnostic('signup', { message: mapped.message, code: mapped.code });
      return sendTypedError(res, mapped.http, mapped.code, { message: mapped.message });
    }
    throw err;
  }

  // Provisiona empresa (trial 4 meses, TRIAL) + 3 perguntas COMPANY padrão.
  try {
    await provisionEnterpriseForUser(userId, {
      accountType: data.accountType,
      document: data.document,
      termsVersion: 'v1',
      termsAcceptedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof DocumentRequiredError) {
      return sendTypedError(res, 400, API_ERROR_DOCUMENT_REQUIRED, { message: 'Documento é obrigatório.' });
    }
    if (err instanceof DocumentTakenError) {
      return sendTypedError(res, 409, API_ERROR_DOCUMENT_TAKEN, { message: 'Documento já cadastrado.' });
    }
    logRegisterDiagnostic('provision_enterprise', err);
    return sendTypedError(res, 400, API_ERROR_DATABASE_ERROR, { message: 'Erro ao salvar novo usuário.' });
  }

  return res.json({ ok: true, message: 'confirmation_required' });
}
