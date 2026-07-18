/**
 * Provisiona a fixture E2E do frontend pelo Better Auth.
 *
 * O script cria/reconcilia as tabelas `user` e `account`, marca o e-mail como
 * verificado, vincula a conta à empresa de teste já existente e verifica o
 * fluxo HTTP autenticado. Não usa Supabase Auth.
 *
 * Uso local: npm run db:seed:e2e
 * Uso no developer: E2E_SEED_ALLOW_REMOTE=true E2E_SEED_ENV=developer
 *   npm run db:seed:e2e
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { getAuth, hashBetterAuthPassword } from '../src/auth/auth.js';
import { getDb, closeDb } from '../src/db/client.js';

const REQUIRED_ENVIRONMENT_VARIABLES = [
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'E2E_TEST_EMAIL',
  'E2E_TEST_PASSWORD',
  'E2E_TEST_ENTERPRISE_ID',
] as const;

function requireEnvironment(): void {
  const missing = REQUIRED_ENVIRONMENT_VARIABLES.filter(
    (name) => !process.env[name]?.trim(),
  );

  if (missing.length > 0) {
    throw new Error(`Variáveis obrigatórias ausentes: ${missing.join(', ')}.`);
  }
}

function assertSeedTarget(): void {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const isLocal = /@(127\.0\.0\.1|localhost)[:/]/.test(databaseUrl);
  const allowRemote = process.env.E2E_SEED_ALLOW_REMOTE === 'true';
  const target = process.env.E2E_SEED_ENV?.trim();

  if (!isLocal && (!allowRemote || target !== 'developer')) {
    throw new Error(
      'Seed remoto recusado. Use E2E_SEED_ALLOW_REMOTE=true e E2E_SEED_ENV=developer.',
    );
  }
}

const USER = {
  email: process.env.E2E_TEST_EMAIL?.trim() ?? '',
  password: process.env.E2E_TEST_PASSWORD ?? '',
  name: 'Gestor E2E',
  enterpriseId: process.env.E2E_TEST_ENTERPRISE_ID?.trim() ?? '',
};

async function findUserId(email: string): Promise<string | null> {
  const rows = await getDb().execute(
    sql`SELECT id FROM public."user" WHERE lower(email) = lower(${email}) LIMIT 1`,
  );
  return (rows[0] as { id?: string } | undefined)?.id ?? null;
}

async function ensureCredentialAccount(userId: string): Promise<void> {
  const db = getDb();
  const passwordHash = await hashBetterAuthPassword(USER.password);
  const rows = await db.execute(sql`
    SELECT id
    FROM public.account
    WHERE user_id = ${userId} AND provider_id = 'credential'
    LIMIT 1
  `);
  const accountId = (rows[0] as { id?: string } | undefined)?.id;

  if (accountId) {
    await db.execute(sql`
      UPDATE public.account
      SET password = ${passwordHash}, updated_at = NOW()
      WHERE id = ${accountId}
    `);
    return;
  }

  await db.execute(sql`
    INSERT INTO public.account (account_id, provider_id, user_id, password)
    VALUES (${userId}, 'credential', ${userId}, ${passwordHash})
  `);
}

async function ensureEnterpriseLink(userId: string): Promise<void> {
  const db = getDb();
  const rows = await db.execute(sql`
    SELECT auth_user_id
    FROM public.enterprise
    WHERE id = ${USER.enterpriseId}
    LIMIT 1
  `);

  if (rows.length === 0) {
    throw new Error(
      'E2E_TEST_ENTERPRISE_ID não existe no banco developer. Crie a fixture antes de executar o seed.',
    );
  }

  await db.execute(sql`
    UPDATE public.enterprise
    SET auth_user_id = ${userId}, updated_at = NOW()
    WHERE id = ${USER.enterpriseId}
  `);
}

function cookieHeader(setCookies: string[]): string {
  return setCookies.map((value) => value.split(';')[0]).join('; ');
}

function formatResponseBody(body: string): string {
  const compactBody = body.replace(/\s+/g, ' ').trim();
  return compactBody.length > 500
    ? `${compactBody.slice(0, 500)}…`
    : compactBody;
}

async function verifyLoginAndSession(): Promise<void> {
  const apiBaseUrl = process.env.E2E_API_BASE_URL?.trim();
  if (!apiBaseUrl) {
    const signIn = await getAuth().api.signInEmail({
      body: { email: USER.email, password: USER.password },
      asResponse: true,
    });
    if (!cookieHeader(signIn.headers.getSetCookie())) {
      throw new Error('signInEmail não retornou cookie de sessão.');
    }
    return;
  }

  const webOrigin = process.env.E2E_WEB_ORIGIN?.trim();
  if (!webOrigin) {
    throw new Error('E2E_WEB_ORIGIN é obrigatório ao validar o gateway publicado.');
  }

  const normalizedApiBaseUrl = apiBaseUrl.replace(/\/+$/, '');
  const loginResponse = await fetch(`${normalizedApiBaseUrl}/api/public/auth/login`, {
    method: 'POST',
    headers: {
      origin: webOrigin,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email: USER.email, password: USER.password, remember: false }),
  });
  const loginBody = await loginResponse.text().catch(() => '');
  if (!loginResponse.ok) {
    throw new Error(
      `login publicado retornou HTTP ${loginResponse.status}: ${formatResponseBody(loginBody)}`,
    );
  }

  if (loginResponse.headers.get('access-control-allow-origin') !== webOrigin) {
    throw new Error('O gateway publicado não permite a origem do frontend developer.');
  }
  if (loginResponse.headers.get('access-control-allow-credentials') !== 'true') {
    throw new Error('O gateway publicado não permite credenciais cross-site.');
  }

  const setCookies = loginResponse.headers.getSetCookie();
  const cookie = cookieHeader(setCookies);
  if (!cookie) {
    throw new Error('login publicado não retornou cookie de sessão.');
  }
  if (!setCookies.some((value) => /;\s*Secure/i.test(value) && /;\s*SameSite=None/i.test(value))) {
    throw new Error('Cookie de sessão do developer precisa usar Secure e SameSite=None.');
  }

  const authUserResponse = await fetch(
    `${normalizedApiBaseUrl}/api/protected/user/auth_user`,
    { headers: { cookie, origin: webOrigin } },
  );
  if (!authUserResponse.ok) {
    throw new Error(
      `auth_user publicado retornou HTTP ${authUserResponse.status} após o login E2E.`,
    );
  }
}

async function main(): Promise<void> {
  requireEnvironment();
  assertSeedTarget();

  const db = getDb();
  let userId = await findUserId(USER.email);

  if (!userId) {
    const result = await getAuth().api.signUpEmail({
      body: { email: USER.email, password: USER.password, name: USER.name },
    });
    userId = (result.user as { id: string }).id;
  }

  await ensureCredentialAccount(userId);
  await db.execute(sql`
    UPDATE public."user"
    SET email_verified = true, name = ${USER.name}, updated_at = NOW()
    WHERE id = ${userId}
  `);
  await db.execute(sql`DELETE FROM public.session WHERE user_id = ${userId}`);
  await ensureEnterpriseLink(userId);
  await verifyLoginAndSession();

  console.log('Fixture E2E Better Auth pronta.');
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Falha ao provisionar a fixture E2E: ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
