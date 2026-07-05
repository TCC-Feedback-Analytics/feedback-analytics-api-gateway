/**
 * Instância central do Better Auth (o único provedor de autenticação do gateway).
 *
 * - Adapter Drizzle embutido (`better-auth/adapters/drizzle`, provider 'pg').
 * - Senha: `hash`/`verify` custom com **bcrypt** — valida os hashes legados do
 *   GoTrue/Supabase sem exigir reset (o hash migrado vive em `account.password`).
 * - `advanced.database.generateId:false`: o id do usuário é gerado pelo Postgres
 *   (`gen_random_uuid()`), permitindo preservar os UUIDs migrados e o vínculo com
 *   `enterprise.auth_user_id`.
 * - E-mail (verificação/reset) via provider próprio (Mailpit local / Resend prod).
 * - `autoSignIn:false` + `requireEmailVerification:true`: anti-enumeração no signup
 *   e login só após confirmação (paridade com RNE-014).
 *
 * Lazy (getAuth): só instancia no primeiro uso, pois exige DATABASE_URL/
 * BETTER_AUTH_SECRET.
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import bcrypt from 'bcryptjs';
import { getDb } from '../db/client.js';
import * as authSchema from './schema.js';
import { sendResetPasswordEmail, sendVerificationEmail } from './email.js';

function buildTrustedOrigins(): string[] {
  const origins = new Set<string>(['http://localhost:5173', 'http://localhost:4173']);
  const siteUrl = process.env.PUBLIC_SITE_URL?.trim();
  if (siteUrl) origins.add(siteUrl);
  const csv = process.env.CORS_ALLOWED_ORIGINS?.trim();
  if (csv) {
    for (const o of csv.split(',')) {
      const v = o.trim();
      if (v) origins.add(v);
    }
  }
  return [...origins];
}

function createAuth() {
  const isProd = process.env.NODE_ENV === 'production';
  const crossSite = String(process.env.COOKIE_CROSS_SITE ?? '').trim() === 'true';
  // Cross-site (web e api em domínios diferentes) → SameSite=None + Secure.
  const sameSite: 'lax' | 'none' = isProd && crossSite ? 'none' : 'lax';

  return betterAuth({
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
    basePath: '/api/auth',
    database: drizzleAdapter(getDb(), { provider: 'pg', schema: authSchema }),
    advanced: {
      // Deixa o Postgres gerar o id (uuid) → preserva os UUIDs migrados.
      database: { generateId: false },
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite,
        secure: sameSite === 'none' ? true : isProd,
        path: '/',
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 8,
      password: {
        hash: (password: string) => bcrypt.hash(password, 10),
        verify: ({ hash, password }: { hash: string; password: string }) =>
          bcrypt.compare(password, hash),
      },
      sendResetPassword: async ({ user, url }) => {
        sendResetPasswordEmail(user.email, url);
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        sendVerificationEmail(user.email, url);
      },
    },
    user: {
      additionalFields: {
        // Telefone do gestor (UNIQUE em `user.phone`); enviado no signUpEmail.
        phone: { type: 'string', required: false, input: true },
      },
    },
    trustedOrigins: buildTrustedOrigins(),
  });
}

type AuthInstance = ReturnType<typeof createAuth>;
let authInstance: AuthInstance | null = null;

export function getAuth(): AuthInstance {
  authInstance ??= createAuth();
  return authInstance;
}
