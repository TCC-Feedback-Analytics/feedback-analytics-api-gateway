// Bloquear acesso a rotas privadas quando não houver usuário autenticado (sessão via cookies httpOnly).
// Delega ao provedor selecionado por AUTH_PROVIDER (Supabase Auth ou Better Auth).

import type { NextFunction, Request, Response } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { sql } from 'drizzle-orm';
import { createSupabaseServerClient } from '../config/supabase.js';
import { isBetterAuth } from '../config/authProvider.js';
import { getAuth } from '../auth/auth.js';
import { getDb } from '../db/client.js';

type SupabaseServerClient = ReturnType<typeof createSupabaseServerClient>;
type RequestUser = {
  id: string;
  email?: string | null;
  phone?: string | null;
  name?: string | null;
};

declare module 'express-serve-static-core' {
  interface Request {
    user?: RequestUser;
    supabase?: SupabaseServerClient;
    // Empresa do usuário autenticado (Better Auth) — base do isolamento por tenant
    // na camada de aplicação. Substitui o auth.uid()/RLS quando fora do Supabase.
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

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (isBetterAuth()) {
    return requireAuthBetter(req, res, next);
  }

  // --- Fluxo Supabase (default) ---
  const supabase = createSupabaseServerClient(req, res);
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  req.user = data.user;
  req.supabase = supabase;

  return next();
}

// --- Fluxo Better Auth: valida a sessão via cookie e resolve a empresa ---
async function requireAuthBetter(
  req: Request,
  res: Response,
  next: NextFunction,
) {
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
