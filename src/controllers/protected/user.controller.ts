import type { Request, Response } from 'express';
import { emailUpdateSchema } from '@feedback/lib-shared/schemas/user/emailUpdateSchema';
import { metadadosUpdateSchema } from '@feedback/lib-shared/schemas/user/metadadosUpdateSchema';
import { resetPasswordSchema } from '@feedback/lib-shared/schemas/user/resetPasswordSchema';
import {
  API_ERROR_INVALID_PAYLOAD,
  API_ERROR_RESET_PASSWORD_FAILED,
  API_ERROR_RESET_PASSWORD_INVALID_TOKEN,
  API_ERROR_RESET_PASSWORD_WEAK,
  API_ERROR_UPDATE_FAILED,
  API_ERROR_VERIFY_FAILED,
} from '../../config/errors.js';
import { sendTypedError } from '../../utils/sendTypedError.js';
import { sql } from 'drizzle-orm';
import { fromNodeHeaders } from 'better-auth/node';
import { isBetterAuth } from '../../config/authProvider.js';
import { getAuth } from '../../auth/auth.js';
import { getDb } from '../../db/client.js';
import { mapResetPasswordError } from '../../auth/errorMap.js';

export async function getAuthUserController(req: Request, res: Response) {
  if (isBetterAuth()) {
    const u = req.user;
    // Reconstrói o envelope que o web lê (user.user_metadata.full_name) a partir
    // do user.name do Better Auth — shape preservado.
    return res.json({
      user: u
        ? {
            id: u.id,
            email: u.email ?? null,
            phone: u.phone ?? null,
            user_metadata: { full_name: u.name ?? null },
          }
        : null,
    });
  }
  return res.json({ user: req.user });
}

export async function patchUserEmailController(req: Request, res: Response) {
  const parsed = emailUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD);
  }

  // --- Better Auth (gated) ---
  if (isBetterAuth()) {
    const webBase = process.env.PUBLIC_SITE_URL ?? 'http://localhost:5173';
    try {
      await getAuth().api.changeEmail({
        body: { newEmail: parsed.data.email, callbackURL: `${webBase}/auth/success` },
        headers: fromNodeHeaders(req.headers),
      });
      return res.json({ user: { id: req.user!.id, email: parsed.data.email } });
    } catch {
      return sendTypedError(res, 400, API_ERROR_UPDATE_FAILED);
    }
  }

  const supabase = req.supabase!;

  const origin = req.get('origin');
  const xfProto = req.headers['x-forwarded-proto'] as string | undefined;
  const xfHost = req.headers['x-forwarded-host'] as string | undefined;
  const base =
    process.env.PUBLIC_SITE_URL ??
    origin ??
    (xfProto && xfHost
      ? `${xfProto}://${xfHost}`
      : `${req.protocol}://${req.get('host')}`);

  const emailRedirectTo = `${base}/api/public/auth/callback?next=/user/dashboard`;

  const { data, error } = await supabase.auth.updateUser(
    { email: parsed.data.email },
    { emailRedirectTo },
  );

  if (error) {
    return sendTypedError(res, 400, API_ERROR_UPDATE_FAILED);
  }

  return res.json({
    user: data.user ? { id: data.user.id, email: data.user.email } : null,
  });
}

export async function patchUserMetadadosController(req: Request, res: Response) {
  const parsed = metadadosUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD);
  }

  // --- Better Auth (gated) ---
  if (isBetterAuth()) {
    const fullName = (parsed.data as { full_name?: string }).full_name ?? null;
    await getDb().execute(
      sql`UPDATE public."user" SET name = ${fullName}, updated_at = now() WHERE id = ${req.user!.id}`,
    );
    return res.json({
      user: { id: req.user!.id, email: req.user!.email ?? null, user_metadata: { full_name: fullName } },
    });
  }

  const supabase = req.supabase!;
  const { data, error } = await supabase.auth.updateUser({
    data: parsed.data,
  });

  if (error) {
    return sendTypedError(res, 400, API_ERROR_UPDATE_FAILED);
  }

  return res.json({
    user: data.user
      ? {
          id: data.user.id,
          email: data.user.email,
          user_metadata: data.user.user_metadata,
        }
      : null,
  });
}

export async function startUserPhoneVerificationController(req: Request, res: Response) {
  const phone = String(req.body?.phone ?? '');
  if (!phone) return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD);

  // --- Better Auth (gated) ---
  // Sem provedor de SMS local, o telefone é atualizado direto aqui (a verificação
  // por OTP em /phone/verify vira no-op). Contrato preservado (200 { ok:true }).
  if (isBetterAuth()) {
    try {
      await getDb().execute(
        sql`UPDATE public."user" SET phone = ${phone}, updated_at = now() WHERE id = ${req.user!.id}`,
      );
      return res.json({ ok: true });
    } catch {
      return sendTypedError(res, 400, API_ERROR_UPDATE_FAILED);
    }
  }

  const supabase = req.supabase!;
  const { error } = await supabase.auth.updateUser({ phone });
  if (error) return sendTypedError(res, 400, API_ERROR_UPDATE_FAILED);
  return res.json({ ok: true });
}

export async function verifyUserPhoneController(req: Request, res: Response) {
  const token = String(req.body?.token ?? '');
  const phone = String(req.body?.phone ?? '');
  if (!token || !phone) return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD);

  // --- Better Auth (gated) ---
  // Sem SMS: OTP não se aplica (o telefone já foi salvo em /phone/start).
  // Mantém o contrato (200 { ok:true }).
  if (isBetterAuth()) {
    return res.json({ ok: true });
  }

  const supabase = req.supabase!;
  const { error } = await supabase.auth.verifyOtp({
    type: 'phone_change',
    token,
    phone,
  });
  if (error) return sendTypedError(res, 400, API_ERROR_VERIFY_FAILED);
  return res.json({ ok: true });
}

type ResetPasswordErrorCode =
  | typeof API_ERROR_INVALID_PAYLOAD
  | typeof API_ERROR_RESET_PASSWORD_FAILED
  | typeof API_ERROR_RESET_PASSWORD_WEAK
  | typeof API_ERROR_RESET_PASSWORD_INVALID_TOKEN;

function mapSupabaseResetPasswordError(error: { code?: string; message?: string }): {
  status: number;
  code: ResetPasswordErrorCode;
  message: string;
} {
  const msg = (error.message ?? '').toLowerCase();

  if (
    error.code === 'weak_password' ||
    msg.includes('weak') ||
    msg.includes('password should be')
  ) {
    return {
      status: 400,
      code: API_ERROR_RESET_PASSWORD_WEAK,
      message: 'A nova senha é muito fraca. Use ao menos 6 caracteres.',
    };
  }

  if (
    error.code === 'session_not_found' ||
    error.code === 'invalid_token' ||
    msg.includes('token') ||
    msg.includes('expired') ||
    msg.includes('session')
  ) {
    return {
      status: 401,
      code: API_ERROR_RESET_PASSWORD_INVALID_TOKEN,
      message: 'O link de redefinição expirou ou é inválido. Solicite um novo.',
    };
  }

  return {
    status: 400,
    code: API_ERROR_RESET_PASSWORD_FAILED,
    message: error.message || 'Não foi possível redefinir a senha.',
  };
}

export async function resetPasswordController(req: Request, res: Response) {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD, {
      issues: parsed.error.issues,
      message: 'Dados inválidos para redefinição de senha.',
    });
  }

  // --- Better Auth (gated) ---
  // O token de reset veio do cookie ba_reset (setado pelo callback) → requireAuth
  // o injetou em req.resetToken. Redefine via Better Auth e limpa o cookie.
  if (isBetterAuth()) {
    if (!req.resetToken) {
      return sendTypedError(res, 401, API_ERROR_RESET_PASSWORD_INVALID_TOKEN, {
        message: 'O link de redefinição expirou ou é inválido. Solicite um novo.',
      });
    }
    try {
      await getAuth().api.resetPassword({
        body: { token: req.resetToken, newPassword: parsed.data.password },
      });
      res.clearCookie('ba_reset', { path: '/api/protected/user/password' });
      return res.json({ ok: true, message: 'Senha redefinida com sucesso.' });
    } catch (err) {
      const mapped = mapResetPasswordError(err);
      return sendTypedError(res, mapped.http, mapped.code, { message: mapped.message });
    }
  }

  const supabase = req.supabase!;

  const { error } = await supabase.auth.updateUser({
    password: parsed.data.password,
  });

  if (error) {
    const mapped = mapSupabaseResetPasswordError({
      code: error.code,
      message: error.message,
    });
    return sendTypedError(res, mapped.status, mapped.code, {
      message: mapped.message,
    });
  }

  return res.json({ ok: true, message: 'Senha redefinida com sucesso.' });
}
