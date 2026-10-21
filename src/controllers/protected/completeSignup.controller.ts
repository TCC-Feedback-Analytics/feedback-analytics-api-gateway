import type { Request, Response } from 'express';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import {
  API_ERROR_INTERNAL_SERVER_ERROR,
  API_ERROR_INVALID_PAYLOAD,
  API_ERROR_PHONE_TAKEN,
} from '../../config/errors.js';
import { sendTypedError } from '../../utils/sendTypedError.js';
import { getDb } from '../../db/client.js';
import { provisionEnterpriseForUser } from '../../auth/enterpriseOnSignup.js';

/**
 * Quem entra com o Google não preenche o formulário de cadastro: o Google dá o
 * nome da pessoa e o e-mail, mas faltam o nome do negócio, o telefone e o aceite
 * dos termos. Esta rota completa o cadastro na primeira entrada.
 */
const completeSignupSchema = z.object({
  fullName: z.string().trim().min(2).max(160),
  phone: z.string().trim().regex(/^\+55\d{10,11}$/),
  terms: z.literal(true),
}).strict();

const PG_UNIQUE_VIOLATION = '23505';

export async function completeSignupController(req: Request, res: Response) {
  const parsed = completeSignupSchema.safeParse(req.body);
  if (!parsed.success) return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD, { issues: parsed.error.issues });
  const userId = req.user!.id;
  const { fullName, phone } = parsed.data;

  try {
    const db = getDb();
    const taken = await db.execute(
      sql`SELECT 1 FROM public."user" WHERE phone = ${phone} AND id <> ${userId} LIMIT 1`,
    );
    if (taken.length > 0) {
      return sendTypedError(res, 409, API_ERROR_PHONE_TAKEN, { message: 'Telefone já cadastrado.' });
    }

    await db.execute(sql`UPDATE public."user" SET name = ${fullName}, phone = ${phone}, updated_at = NOW() WHERE id = ${userId}`);
    // Cria a empresa se ainda não existe e grava o aceite dos termos.
    await provisionEnterpriseForUser(userId, { termsVersion: 'v1', termsAcceptedAt: new Date().toISOString() });
    return res.json({ ok: true });
  } catch (error) {
    if ((error as { code?: string; cause?: { code?: string } }).code === PG_UNIQUE_VIOLATION
      || (error as { cause?: { code?: string } }).cause?.code === PG_UNIQUE_VIOLATION) {
      return sendTypedError(res, 409, API_ERROR_PHONE_TAKEN, { message: 'Telefone já cadastrado.' });
    }
    console.error('[complete-signup] falha ao completar o cadastro');
    return sendTypedError(res, 500, API_ERROR_INTERNAL_SERVER_ERROR);
  }
}
