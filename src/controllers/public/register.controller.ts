import type { Request, Response } from 'express';
import { registerSchema } from '@feedback/lib-shared/schemas/public/registerSchema';
import {
  API_ERROR_DATABASE_ERROR,
  API_ERROR_DOCUMENT_TAKEN,
  API_ERROR_INTERNAL_ERROR,
  API_ERROR_INVALID_PAYLOAD,
  API_ERROR_PHONE_TAKEN,
  API_ERROR_EMAIL_TAKEN,
  API_ERROR_DOCUMENT_REQUIRED,
} from '../../config/errors.js';
import { sendTypedError } from '../../utils/sendTypedError.js';
import { sql } from 'drizzle-orm';
import { APIError } from 'better-auth/api';
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

/**
 * Loga, sem interromper o fluxo, falhas das etapas do cadastro — para confirmar a
 * ORIGEM de uma eventual falha sob carga: o signUpEmail do Better Auth ou o
 * provisionamento da empresa.
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

    return await registerBetter(res, parsed.data as RegisterData);
  } catch (err) {
    console.error('Register endpoint error:', err);
    return sendTypedError(res, 500, API_ERROR_INTERNAL_ERROR);
  }
}

/**
 * Cadastro no Better Auth: pré-checa telefone/documento, cria o usuário
 * (signUpEmail dispara o e-mail de verificação via SMTP) e provisiona a empresa +
 * perguntas padrão. Preserva os códigos tipados e a anti-enumeração de e-mail
 * (duplicado → 200 confirmation_required). Erros inesperados sobem para o
 * try/catch do registerUserController (→ 500).
 */
async function registerBetter(res: Response, data: RegisterData) {
  const db = getDb();

  // Pré-checagem de duplicidade (mensagem 409 amigável; a barreira real são as UNIQUE).
  const phoneDup = await db.execute(
    sql`SELECT 1 FROM public."user" WHERE phone = ${data.phone} LIMIT 1`,
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

  // E-mail já cadastrado → anti-enumeração (200 confirmation_required). Feito ANTES
  // do signUpEmail: para e-mail existente o Better Auth devolve um "sucesso fake"
  // com id aleatório (não-uuid, sem criar user), que quebraria o provisionamento.
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
