// Recria o schema do banco LOCAL (dev) e aplica o seed.
// Uso: npm run db:reset   (exige o Postgres local no ar: npm run db:local:up)
//
// SEGURANÇA: recusa rodar em qualquer DATABASE_URL que não seja local — este
// script faz DROP SCHEMA. Nunca aponte para Supabase/produção.

import 'dotenv/config';
import postgres from 'postgres';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const url = process.env.DATABASE_URL ?? '';

const isLocal = /@(127\.0\.0\.1|localhost)[:/]/.test(url);
const looksRemote = /supabase|pooler|neon|amazonaws|render|railway/i.test(url);
if (!isLocal || looksRemote) {
  console.error('❌ DATABASE_URL não parece local. Este script faz DROP SCHEMA e só roda localmente.');
  console.error('   Esperado algo como postgresql://postgres:postgres@127.0.0.1:5433/feedback');
  process.exit(1);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });

// Ordem de aplicação das tabelas respeitando as FKs.
const TABLE_ORDER = [
  'auth.users',
  // Tabelas do Better Auth (AUTH_PROVIDER=betterauth). Antes de enterprise —
  // enterprise.auth_user_id passa a apontar para public.user.id.
  'public.better_auth',
  'public.enterprise',
  'public.catalog_items',
  'public.collecting_data_enterprise',
  'public.collection_points',
  'public.customer',
  'public.tracked_devices',
  'public.questions_of_feedbacks',
  'public.feedback_question_subquestions',
  'public.feedback',
  'public.feedback_question_answers',
  'public.feedback_subquestion_answers',
  'public.feedback_analysis',
  'public.feedback_insights_report',
];

const read = (p) => readFileSync(join(ROOT, p), 'utf8');

async function apply(label, content) {
  process.stdout.write(`  >>> ${label} ... `);
  await sql.unsafe(content);
  console.log('OK');
}

// Aplica best-effort (ignora erro) — usado no 1º pass de funções, antes das
// tabelas: funções `LANGUAGE sql` que referenciam tabelas ainda vão falhar aqui
// (recriadas no 2º pass); as trigger-functions (plpgsql) já ficam criadas para
// as tabelas poderem declarar seus triggers.
async function applySoft(label, content) {
  process.stdout.write(`  >>> ${label} ... `);
  try {
    await sql.unsafe(content);
    console.log('OK');
  } catch {
    console.log('(adiado)');
  }
}

try {
  console.log('Recriando schema local...');
  await apply('reset schemas', 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS auth CASCADE;');
  await apply('shim', read('db/local/00-shim.sql'));

  const fnFiles = readdirSync(join(ROOT, 'db/schema/functions')).filter((f) => f.endsWith('.sql')).sort();
  const fnLabel = (f) => `fn ${f.replace(/__.*\.sql$/, '')}`;

  // Pass 1 (antes das tabelas): cria as trigger-functions que as tabelas usam.
  for (const f of fnFiles) await applySoft(fnLabel(f), read(`db/schema/functions/${f}`));

  for (const t of TABLE_ORDER) {
    await apply(`table ${t}`, read(`db/schema/tables/${t}.sql`));
  }

  // Pass 2 (depois das tabelas): recria todas as funções (agora as refs existem).
  for (const f of fnFiles) await apply(fnLabel(f), read(`db/schema/functions/${f}`));

  for (const v of readdirSync(join(ROOT, 'db/schema/views')).filter((f) => f.endsWith('.sql')).sort()) {
    await apply(`view ${v}`, read(`db/schema/views/${v}`));
  }

  const seedPath = join(ROOT, 'db/local/seed.sql');
  if (existsSync(seedPath)) {
    await apply('seed', readFileSync(seedPath, 'utf8'));
  } else {
    console.log('  (sem db/local/seed.sql — schema aplicado sem seed)');
  }

  console.log('\n✅ Banco local pronto.');
} catch (e) {
  console.error('\n❌ Falhou:', e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
