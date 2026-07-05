import type { Request, Response } from 'express';
import { createSupabaseServerClient } from '../../config/supabase.js';
import { isBetterAuth } from '../../config/authProvider.js';

export async function authCallbackController(req: Request, res: Response) {
  const q = req.query as Record<string, unknown>;
  const type = String(q.type ?? '');
  const tokenHash = String(q.token_hash ?? '') || String(q.token ?? '');
  const nextParam = String(q.next ?? '/user/dashboard');
  const next = nextParam.startsWith('/') ? nextParam : '/user/dashboard';

  // --- Better Auth (gated) ---
  // A verificação de e-mail (signup) é tratada direto pelo /api/auth/verify-email
  // do Better Auth (o link já redireciona para o web). Aqui só tratamos o
  // RECOVERY: guardamos o token de reset num cookie httpOnly restrito à rota de
  // senha e mandamos o usuário para a página de redefinição — assim o web segue
  // chamando PATCH /password baseado em "sessão", sem precisar ler token.
  if (isBetterAuth()) {
    const webBase = process.env.PUBLIC_SITE_URL ?? 'http://localhost:5173';
    const isProd = process.env.NODE_ENV === 'production';
    const crossSite = String(process.env.COOKIE_CROSS_SITE ?? '').trim() === 'true';
    const sameSite: 'lax' | 'none' = isProd && crossSite ? 'none' : 'lax';

    if (type === 'recovery' && tokenHash) {
      res.cookie('ba_reset', tokenHash, {
        httpOnly: true,
        sameSite,
        secure: sameSite === 'none' ? true : isProd,
        path: '/api/protected/user/password',
        maxAge: 60 * 60 * 1000, // 1h (janela do reset)
      });
      return res.redirect(`${webBase}${next}`);
    }

    return res.redirect(`${webBase}/auth/success?next=${encodeURIComponent(next)}`);
  }

  // --- Supabase (default) ---
  const supabase = createSupabaseServerClient(req, res);

  if (type === 'email_change' && tokenHash) {
    // Fluxo de troca de e-mail: verifica o OTP para confirmar a mudança
    const { error } = await supabase.auth.verifyOtp({
      type: 'email_change',
      token_hash: tokenHash,
    });
    if (error) return res.redirect('/auth/link-expired');
  } else if (type === 'recovery' && tokenHash) {
    // Fluxo de recuperação de senha: troca o token por uma sessão autenticada.
    // Com a sessão ativa, o frontend pode chamar PATCH /api/protected/user/password.
    const { error } = await supabase.auth.verifyOtp({
      type: 'recovery',
      token_hash: tokenHash,
    });
    if (error) return res.redirect('/auth/link-expired');
  } else {
    // Fluxo padrão de confirmação de cadastro (signup)
    const { error } = await supabase.auth.exchangeCodeForSession(req.url);
    if (error) return res.redirect('/auth/link-expired');
  }

  return res.redirect(`/auth/success?next=${encodeURIComponent(next)}`);
}
