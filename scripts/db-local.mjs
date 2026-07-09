// Recria o schema do banco LOCAL (dev) a partir das MIGRATIONS Drizzle e aplica o seed.
// Fluxo (ADR-0001, Fase 2 · Passo 6): DROP → shim + auth.users → drizzle-kit migrate → seed.
// Uso: npm run db:reset   (exige o Postgres local no ar: npm run db:local:up)
//
// SEGURANÇA: recusa rodar em qualquer DATABASE_URL que não seja local — este
// script faz DROP SCHEMA. Nunca aponte para Supabase/produção.

import 'dotenv/config';
import postgres from 'postgres';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
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
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

async function apply(label, content) {
  process.stdout.write(`  >>> ${label} ... `);
  await sql.unsafe(content);
  console.log('OK');
}

try {
  console.log('Recriando schema local (via migrations Drizzle)...');

  // Zera public + auth + o histórico de migrations (schema `drizzle`). Sem dropar
  // o `drizzle`, o migrate acha que 0000/0001 já foram aplicados e NÃO recria nada.
  await apply(
    'reset schemas',
    'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS auth CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE;',
  );

  // Shim de portabilidade Postgres-puro: recria auth.uid()/roles que o schema `auth`
  // do Supabase proveria. Pós-Passo 7 o schema NÃO referencia mais auth.users, então
  // a tabela auth.users mínima deixou de ser aplicada (retirar o shim por completo,
  // já que auth.uid()/roles viraram código morto, é um cleanup opcional).
  await apply('shim', read('db/local/00-shim.sql'));

  // Aplica as migrations versionadas: 0000 (tabelas/FKs/índices/view) + 0001
  // (funções/triggers/RLS). MESMA sequência que a produção usaria.
  console.log('  >>> drizzle-kit migrate ...');
  execSync('npx drizzle-kit migrate', { cwd: ROOT, stdio: 'inherit', env: process.env });

  const seedPath = join(ROOT, 'db/local/seed.sql');
  if (existsSync(seedPath)) {
    await apply('seed', readFileSync(seedPath, 'utf8'));
  } else {
    console.log('  (sem db/local/seed.sql — schema aplicado sem seed)');
  }

  console.log('\n✅ Banco local pronto (migrations + seed).');
} catch (e) {
  console.error('\n❌ Falhou:', e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
