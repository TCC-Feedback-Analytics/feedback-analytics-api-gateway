/**
 * Semeia o usuário de teste do E2E (web) no banco LOCAL, do jeito que o Better
 * Auth exige: cria `user` + `account` (signUpEmail → senha bcrypt), provisiona a
 * empresa (+3 perguntas COMPANY padrão) e marca o e-mail como verificado — o
 * mesmo atalho de `src/tests/e2e/authCutover.e2e.ts` (o fluxo real clicaria no
 * link do Mailpit). Sem isso o login do e2e falha com 401, porque o seed SQL
 * (`db/local/seed.sql`) só popula o `auth.users` legado, que o Better Auth não usa.
 *
 * Uso (na pasta backends/api-gateway, com o Postgres local no ar):
 *   npm run db:seed:e2e
 * Já roda automaticamente no fim de `npm run db:reset`. Idempotente: re-executar
 * não duplica (checa usuário e empresa antes de criar).
 *
 * Credenciais: E2E_TEST_EMAIL / E2E_TEST_PASSWORD, com fallback para os valores
 * que o web usa por padrão — paridade com
 * `feedback-analytics-web/e2e/fixtures/test-data.ts`.
 *
 * SEGURANÇA: recusa rodar em DATABASE_URL não-local (cria um usuário conhecido).
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { getAuth } from '../src/auth/auth.js';
import { getDb, closeDb } from '../src/db/client.js';
import {
  provisionEnterpriseForUser,
  DocumentTakenError,
} from '../src/auth/enterpriseOnSignup.js';

const url = process.env.DATABASE_URL ?? '';
const isLocal = /@(127\.0\.0\.1|localhost)[:/]/.test(url);
const looksRemote = /supabase|pooler|neon|amazonaws|render|railway/i.test(url);
if (!url || !isLocal || looksRemote) {
  console.error('❌ DATABASE_URL não parece local. Este script cria um usuário de teste e só roda localmente.');
  console.error('   Esperado algo como postgresql://postgres:postgres@127.0.0.1:5433/feedback');
  process.exit(1);
}

// Telefone/documento fixos (CNPJ válido só-dígitos). Só o e-mail/senha são
// parametrizáveis — é um único usuário de teste.
const USER = {
  email: process.env.E2E_TEST_EMAIL || 'gestor@empresateste.com',
  password: process.env.E2E_TEST_PASSWORD || 'Teste@123',
  name: 'Empresa Teste',
  phone: '+5511987654321',
  document: '11222333000181',
  accountType: 'CNPJ' as const,
};

async function findUserId(email: string): Promise<string | null> {
  const rows = await getDb().execute(
    sql`SELECT id FROM public."user" WHERE lower(email) = lower(${email}) LIMIT 1`,
  );
  return (rows[0] as { id?: string } | undefined)?.id ?? null;
}

async function hasEnterprise(userId: string): Promise<boolean> {
  const rows = await getDb().execute(
    sql`SELECT 1 FROM public.enterprise WHERE auth_user_id = ${userId} LIMIT 1`,
  );
  return rows.length > 0;
}

async function main(): Promise<void> {
  const db = getDb();

  let userId = await findUserId(USER.email);

  if (!userId) {
    // Cria user + account (senha bcrypt) via Better Auth. signUpEmail dispara o
    // e-mail de verificação (capturado pelo Mailpit local) — que ignoramos abaixo.
    const result = await getAuth().api.signUpEmail({
      body: { email: USER.email, password: USER.password, name: USER.name, phone: USER.phone },
    });
    userId = (result.user as { id: string }).id;
    console.log(`  usuário criado: ${USER.email} (${userId})`);
  } else {
    console.log(`  usuário já existe: ${USER.email} (${userId})`);
  }

  // Provisiona a empresa (+3 perguntas COMPANY) se ainda não tiver.
  if (await hasEnterprise(userId)) {
    console.log('  empresa já provisionada');
  } else {
    try {
      await provisionEnterpriseForUser(userId, {
        accountType: USER.accountType,
        document: USER.document,
        termsVersion: 'v1',
        termsAcceptedAt: new Date().toISOString(),
      });
      console.log(`  empresa provisionada (doc ${USER.document})`);
    } catch (err) {
      if (err instanceof DocumentTakenError) {
        console.warn(`  ⚠️ documento ${USER.document} já pertence a outra empresa — provisionamento pulado.`);
      } else {
        throw err;
      }
    }
  }

  // Atalho de teste: verifica o e-mail direto (requireEmailVerification bloqueia
  // o login sem isso; o fluxo real clicaria no link do Mailpit).
  await db.execute(sql`UPDATE public."user" SET email_verified = true WHERE id = ${userId}`);

  // Auto-verificação: garante que o usuário ficou de fato logável (mesmo caminho
  // que o loginController usa). Falha ruidosa se algo saiu do lugar.
  const signIn = await getAuth().api.signInEmail({
    body: { email: USER.email, password: USER.password },
    asResponse: true,
  });
  if (signIn.headers.getSetCookie().length === 0) {
    throw new Error('signInEmail não retornou cookie — o usuário não ficou logável.');
  }

  console.log(`\n✅ Usuário de e2e pronto e logável: ${USER.email} / ${USER.password}`);
  await closeDb();
}

main().catch(async (err) => {
  console.error('\n❌ Falha ao semear o usuário de e2e:', err);
  await closeDb();
  process.exit(1);
});
