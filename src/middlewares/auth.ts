// Bloquear acesso a rotas privadas quando não houver usuário autenticado (sessão
// via cookies httpOnly do Better Auth).

import type { NextFunction, Request, Response } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { sql } from 'drizzle-orm';
import { getAuth } from '../auth/auth.js';
import { getDb } from '../db/client.js';

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
    // de aplicação (a role do Drizzle ignora a RLS).
    enterpriseId?: string;
    // Token de redefinição de senha (fluxo de recuperação), lido do cookie ba_reset
    // apenas na rota /password. Consumido pelo resetPasswordController.
    resetToken?: string;
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

// Valida a sessão via cookie (Better Auth) e resolve a empresa do usuário.
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
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

      // Resolve a empresa do usuário (isolamento por tenant na aplicação).
      const rows = await getDb().execute(
        sql`SELECT id FROM public.enterprise WHERE auth_user_id = ${user.id} LIMIT 1`,
      );
      req.enterpriseId = (rows[0] as { id?: string } | undefined)?.id;

      return next();
    }

    // Recuperação de senha: sem sessão, mas com o cookie ba_reset setado pelo
    // callback. Aceito SOMENTE na rota de senha (o cookie já é path-scoped; aqui
    // reforçamos no servidor). O token é validado depois pelo Better Auth.
    if (req.path.endsWith('/password')) {
      const resetToken = readCookie(req, 'ba_reset');
      if (resetToken) {
        req.resetToken = resetToken;
        return next();
      }
    }

    return res.status(401).json({ error: 'unauthorized' });
  } catch {
    return res.status(401).json({ error: 'unauthorized' });
  }
}
