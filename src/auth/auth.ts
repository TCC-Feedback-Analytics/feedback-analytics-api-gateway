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
// Tabelas do Better Auth vêm da FONTE ÚNICA (drizzle/schema.ts) — ADR-0001 Fase 2.
import { user, session, account, verification } from '../../drizzle/schema.js';
import { sendResetPasswordEmail, sendVerificationEmail } from './email.js';
import { provisionEnterpriseForUser } from './enterpriseOnSignup.js';

export function hashBetterAuthPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

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

/**
 * "Entrar com Google": só liga com as credenciais no ambiente (GOOGLE_CLIENT_ID e
 * GOOGLE_CLIENT_SECRET). O endereço de retorno no Google Cloud é
 * {BETTER_AUTH_URL}/api/auth/callback/google (a URL da Web, que repassa ao gateway).
 */
export function googleProviderConfig(env: NodeJS.ProcessEnv = process.env) {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { google: { clientId, clientSecret } } : undefined;
}

/**
 * Conta criada por um provedor social (Google): cria a empresa na hora, sem os
 * termos — a Web leva a pessoa a "Complete seu cadastro" (telefone, nome do
 * negócio e aceite). O cadastro com senha cria a empresa no próprio controller.
 */
export async function provisionEnterpriseForSocialAccount(account: { userId: string; providerId: string }) {
  if (account.providerId === 'credential') return;
  try {
    await provisionEnterpriseForUser(account.userId, {});
  } catch {
    // Não derruba a entrada: a empresa é criada ao completar o cadastro.
    console.error('[auth] falha ao criar a empresa da conta social');
  }
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
    database: drizzleAdapter(getDb(), { provider: 'pg', schema: { user, session, account, verification } }),
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
      // Mesmo mínimo do schema (MIN_PASSWORD_LENGTH); a força é conferida nos controllers.
      minPasswordLength: 10,
      password: {
        hash: hashBetterAuthPassword,
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
    socialProviders: googleProviderConfig(),
    account: {
      // Mesmo e-mail com senha e com Google = a mesma conta (o Google verifica o e-mail).
      accountLinking: { enabled: true, trustedProviders: ['google'] },
    },
    databaseHooks: {
      account: {
        create: {
          after: async (account) => provisionEnterpriseForSocialAccount(account),
        },
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
