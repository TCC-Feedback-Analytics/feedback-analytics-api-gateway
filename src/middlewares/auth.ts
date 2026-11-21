// Bloquear acesso a rotas privadas quando não houver usuário autenticado (sessão
// via cookies httpOnly do Better Auth).

import type { NextFunction, Request, Response } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { sql } from 'drizzle-orm';
import { getAuth } from '../auth/auth.js';
import { getDb } from '../db/client.js';
import { API_ERROR_ACCOUNT_DELETION_PENDING } from '../config/errors.js';

type RequestUser = {
  id: string;
  email?: string | null;
  phone?: string | null;
  name?: string | null;
};

declare module 'express-serve-static-core' {
  interface Request {
    user?: RequestUser;
    // Empresa do usuário autenticado — base do isolamento por tenant na camada
    // de aplicação (a RLS não separa empresas).
    enterpriseId?: string;
    // Token de redefinição de senha (fluxo de recuperação), lido do cookie ba_reset
    // apenas na rota /password, com ou sem sessão. Consumido pelo resetPasswordController.
    resetToken?: string;
    // Quando a sessão nasceu: quem só entra pelo Google precisa de uma entrada
    // recente para pedir a exclusão da conta.
    sessionCreatedAt?: Date;
    // Data em que a conta será apagada, ou null se ela está ativa.
    deletionScheduledFor?: Date | null;
  }
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}

// Recuperação de senha: o callback grava o token no cookie ba_reset. Aceito SOMENTE
// na rota de senha (o cookie já é path-scoped; aqui reforçamos no servidor). O token
// é validado depois pelo Better Auth.
function readResetTokenOnPasswordRoute(req: Request): string | undefined {
  if (!req.path.endsWith('/password')) return undefined;
  return readCookie(req, 'ba_reset');
}

/**
 * Valida a sessão via cookie (Better Auth) e resolve a empresa do usuário.
 *
 * Conta com exclusão agendada fica parada: recebe 403 `account_deletion_pending`,
 * com a data, em todas as rotas, menos nas marcadas com `allowPendingDeletion`
 * (as que a Web usa para mostrar o aviso e desistir da exclusão).
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    // Lido antes da sessão: o gestor que abre o link de recuperação no navegador em
    // que já está logado também precisa do token para trocar a senha.
    req.resetToken = readResetTokenOnPasswordRoute(req);

    const result = await getAuth().api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (result?.user) {
      const user = result.user as {
        id: string;
        email?: string | null;
        phone?: string | null;
        name?: string | null;
      };
      req.user = {
        id: user.id,
        email: user.email ?? null,
        phone: user.phone ?? null,
        name: user.name ?? null,
      };

      req.sessionCreatedAt = result.session?.createdAt ? new Date(result.session.createdAt) : undefined;

      // Resolve a empresa do usuário (isolamento por tenant na aplicação) e se a
      // conta tem exclusão agendada.
      const rows = await getDb().execute(
        sql`SELECT e.id, u.deletion_scheduled_for
            FROM public."user" u LEFT JOIN public.enterprise e ON e.auth_user_id = u.id
            WHERE u.id = ${user.id} LIMIT 1`,
      );
      const row = rows[0] as { id?: string | null; deletion_scheduled_for?: Date | string | null } | undefined;
      req.enterpriseId = row?.id ?? undefined;
      req.deletionScheduledFor = row?.deletion_scheduled_for ? new Date(row.deletion_scheduled_for) : null;

      if (req.deletionScheduledFor && !req.allowPendingDeletion) {
        return res.status(403).json({
          error: API_ERROR_ACCOUNT_DELETION_PENDING,
          deletion_scheduled_for: req.deletionScheduledFor.toISOString(),
        });
      }
      return next();
    }

    // Sem sessão, a rota de senha passa só com o token de recuperação.
    if (req.resetToken) return next();

    return res.status(401).json({ error: 'unauthorized' });
  } catch {
    return res.status(401).json({ error: 'unauthorized' });
  }
}
