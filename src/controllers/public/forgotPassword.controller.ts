import type { Request, Response } from 'express';
import z from 'zod';
import { sendTypedError } from '../../utils/sendTypedError.js';
import { API_ERROR_INVALID_PAYLOAD } from '../../config/errors.js';
import { getAuth } from '../../auth/auth.js';

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
    console.warn('[forgot-password]', (err as { message?: string })?.message ?? err);
  }

  return res.json({
    ok: true,
    message: 'Se este e-mail estiver cadastrado, você receberá as instruções em breve.',
  });
}
