/**
 * Instância central do Better Auth (o único provedor de autenticação do gateway).
 *
 * - Adapter Drizzle embutido (`better-auth/adapters/drizzle`, provider 'pg').
 * - Senha: `hash`/`verify` custom com **bcrypt** — valida os hashes legados do
 *   GoTrue/Supabase sem exigir reset (o hash migrado vive em `account.password`).
 * - `advanced.database.generateId:false`: o id do usuário é gerado pelo Postgres
 *   (`gen_random_uuid()`), permitindo preservar os UUIDs migrados e o vínculo com
 *   `enterprise.auth_user_id`.
 * - E-mail (verificação/reset) via provider próprio (Mailpit local / Brevo por SMTP em produção).
 * - `autoSignIn:false` + `requireEmailVerification:true`: anti-enumeração no signup
 *   e login só após confirmação (paridade com RNE-014).
 * - Entrar com Google não guarda os tokens do Google em `account` (discardOAuthTokens).
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
import {
  sendChangeEmailApproval,
  sendChangeEmailVerification,
  sendResetPasswordEmail,
  sendVerificationEmail,
} from './email.js';
import { provisionEnterpriseForUser } from './enterpriseOnSignup.js';
import { localWebOrigins } from '../config/localWebOrigins.js';

export function hashBetterAuthPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export function verifyBetterAuthPassword(hash: string, password: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function buildTrustedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const origins = new Set<string>(localWebOrigins(env));
  const siteUrl = env.PUBLIC_SITE_URL?.trim();
  if (siteUrl) origins.add(siteUrl);
  const csv = env.CORS_ALLOWED_ORIGINS?.trim();
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

/**
 * Tokens do Google fora da tabela `account`: o Better Auth lê o perfil com eles antes
 * de gravar a conta, e o sistema não chama o Google depois do login. Não guardar é
 * melhor que cifrar: o `encryptOAuthTokens` deixaria o `id_token` (um JWT com e-mail,
 * nome e foto) em texto. Vale na criação e em toda atualização da conta, o que também
 * limpa tokens gravados antes desta regra quando a pessoa entra de novo.
 */
export async function discardOAuthTokens() {
  return { data: { accessToken: null, refreshToken: null, idToken: null } };
}

/**
 * Rotas HTTP nativas de e-mail e senha que respondem 404. O login, o cadastro, o
 * pedido de recuperação e a nova senha passam pelas rotas do gateway, que contam as
 * tentativas no banco (libs/authRateLimit.ts) e chamam o Better Auth por dentro do
 * servidor; a porta nativa deixaria contornar esse limite. A Web não chama nenhuma
 * delas, nem a troca e a conferência de senha com sessão aberta.
 * A troca de e-mail também só passa pelo gateway (PATCH /api/protected/user/email):
 * lá o requireAuth barra a conta com exclusão agendada.
 * Continuam abertas as rotas que a Web e os e-mails usam: sign-in/social,
 * callback/google, verify-email, reset-password/:token e list-accounts.
 */
export const DISABLED_NATIVE_AUTH_PATHS = [
  '/sign-in/email',
  '/sign-up/email',
  '/request-password-reset',
  '/reset-password',
  '/change-password',
  '/verify-password',
  '/change-email',
];

export type ChangeEmailStep = 'troca-aprovada' | 'email-trocado';

/**
 * Os dois links da troca de e-mail voltam para a mesma página da Web. O `tipo` no
 * destino diz em que passo a pessoa está: aprovou no endereço atual ou confirmou o novo.
 */
export function withChangeEmailStep(url: string, step: ChangeEmailStep): string {
  const link = new URL(url);
  const callback = link.searchParams.get('callbackURL');
  if (!callback || !URL.canParse(callback)) return url;
  const destination = new URL(callback);
  destination.searchParams.set('tipo', step);
  link.searchParams.set('callbackURL', destination.toString());
  return link.toString();
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
    disabledPaths: DISABLED_NATIVE_AUTH_PATHS,
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
          verifyBetterAuthPassword(hash, password),
      },
      sendResetPassword: async ({ user, url }) => {
        sendResetPasswordEmail(user.email, url);
      },
      // Nova senha encerra todas as sessões: quem tinha a senha antiga não continua dentro.
      revokeSessionsOnPasswordReset: true,
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      // Conta já verificada só recebe este e-mail na troca de endereço: o reenvio da
      // confirmação do cadastro não sai para quem já confirmou.
      sendVerificationEmail: async ({ user, url }) => {
        if (user.emailVerified) {
          sendChangeEmailVerification(user.email, withChangeEmailStep(url, 'email-trocado'));
          return;
        }
        sendVerificationEmail(user.email, url);
      },
    },
    user: {
      additionalFields: {
        // Telefone do gestor (UNIQUE em `user.phone`); enviado no signUpEmail.
        phone: { type: 'string', required: false, input: true },
      },
      // Troca de e-mail (PATCH /api/protected/user/email), em dois passos: o endereço
      // atual aprova, e só então o link de confirmação vai para o endereço novo (pelo
      // sendVerificationEmail). Com a sessão roubada, ninguém leva a conta para outro e-mail.
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
          sendChangeEmailApproval(user.email, newEmail, withChangeEmailStep(url, 'troca-aprovada'));
        },
      },
      // "Excluir minha conta" não usa o deleteUser do Better Auth, que apaga na hora:
      // o pedido, a confirmação pelo e-mail e os 15 dias de carência ficam em
      // services/accountDeletion.service.ts.
    },
    socialProviders: googleProviderConfig(),
    account: {
      // Mesmo e-mail com senha e com Google = a mesma conta (o Google verifica o e-mail).
      accountLinking: { enabled: true, trustedProviders: ['google'] },
    },
    databaseHooks: {
      account: {
        create: {
          before: discardOAuthTokens,
          after: async (account) => provisionEnterpriseForSocialAccount(account),
        },
        update: { before: discardOAuthTokens },
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
