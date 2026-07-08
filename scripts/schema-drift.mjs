// Guard-rail anti-drift do schema local (ADR-0001, Fase 1).
//
// Lê um dump `pg_dump --schema=public --schema-only` do STDIN, normaliza
// (remove cabeçalho volátil, comentários e SETs) e:
//   - modo padrão (check): compara com o golden db/schema/.drift-snapshot.sql;
//     sai 1 se divergir, imprimindo as primeiras diferenças + o que fazer.
//   - modo --write: (re)grava o golden a partir do dump atual.
//
// O golden é a "allowlist" materializada: é o schema local ACEITO, versionado.
// Qualquer mudança estrutural (em db/schema/, no shim, ou na ordem do
// db-local.mjs) muda o dump → o check FALHA até o golden ser regenerado
// conscientemente e a mudança ser espelhada em drizzle/ e db/cutover/ (ADR-0001).
//
// Uso:
//   <pg_dump ...> | node scripts/schema-drift.mjs           # check (CI)
//   <pg_dump ...> | node scripts/schema-drift.mjs --write   # regenera o golden
// Atalhos: npm run db:drift:check / npm run db:drift:snapshot (usam o container local).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(__dirname, '..', 'db', 'schema', '.drift-snapshot.sql');
const GOLDEN_LABEL = 'db/schema/.drift-snapshot.sql';

const DUMP_CMD =
  'docker exec feedback-api-db pg_dump --schema=public --schema-only --no-owner --no-privileges -U postgres -d feedback';

// Remove tudo que é volátil/irrelevante entre execuções (cabeçalho com versão e
// timestamp, comentários por objeto, session settings) e estabiliza brancos.
function normalize(raw) {
  const kept = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.startsWith('--')) continue; // comentários (inclui o cabeçalho "Dumped from ...")
    if (line.startsWith('\\')) continue; // meta-comandos psql: \restrict/\unrestrict trazem token ALEATÓRIO por dump
    if (/^SET\s/.test(line)) continue; // session settings
    if (/^SELECT pg_catalog\.set_config/.test(line)) continue;
    kept.push(line);
  }
  const collapsed = [];
  for (const l of kept) {
    if (l === '' && collapsed[collapsed.length - 1] === '') continue; // colapsa brancas
    collapsed.push(l);
  }
  while (collapsed.length && collapsed[0] === '') collapsed.shift();
  while (collapsed.length && collapsed[collapsed.length - 1] === '') collapsed.pop();
  return collapsed.join('\n') + '\n';
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const write = process.argv.includes('--write');
const raw = readStdin();

if (!raw.trim()) {
  console.error('✖ schema-drift: STDIN vazio.');
  console.error(`  Esperava a saída de: ${DUMP_CMD}`);
  console.error('  (o container Postgres local precisa estar no ar: npm run db:local:up)');
  process.exit(2);
}

const current = normalize(raw);

if (write) {
  writeFileSync(GOLDEN, current, 'utf8');
  console.log(`✔ golden regravado: ${GOLDEN_LABEL} (${current.split('\n').length - 1} linhas)`);
  process.exit(0);
}

let golden;
try {
  golden = readFileSync(GOLDEN, 'utf8');
} catch {
  console.error(`✖ schema-drift: golden ausente (${GOLDEN_LABEL}).`);
  console.error(`  Gere com: ${DUMP_CMD} | node scripts/schema-drift.mjs --write`);
  process.exit(2);
}

if (golden === current) {
  console.log(`✔ schema local sem drift (bate com ${GOLDEN_LABEL}).`);
  process.exit(0);
}

const g = golden.split('\n');
const c = current.split('\n');
const max = Math.max(g.length, c.length);
const diffs = [];
for (let i = 0; i < max && diffs.length < 40; i++) {
  if (g[i] !== c[i]) {
    diffs.push(`  L${i + 1}\n    - golden: ${g[i] ?? '(fim do arquivo)'}\n    + atual : ${c[i] ?? '(fim do arquivo)'}`);
  }
}

console.error(`✖ DRIFT detectado: o schema montado por db-local.mjs (db/schema/) mudou vs ${GOLDEN_LABEL}.`);
console.error('');
console.error(diffs.join('\n'));
if (Math.abs(g.length - c.length) > 0 || diffs.length >= 40) {
  console.error(`\n  ... (golden: ${g.length - 1} linhas, atual: ${c.length - 1} linhas)`);
}
console.error('');
console.error('O que fazer (ADR-0001 · docs/adr/0001-fonte-unica-de-schema.md):');
console.error('  1) Se a mudança é INTENCIONAL, regenere o golden:');
console.error('       npm run db:local:up && node scripts/db-local.mjs && npm run db:drift:snapshot');
console.error('  2) Espelhe a MESMA mudança em drizzle/schema.ts (+ npm run db:generate) e,');
console.error('     se for para produção, em db/cutover/ (SQL idempotente).');
console.error('  3) Veja o checklist em .github/PULL_REQUEST_TEMPLATE.md.');
process.exit(1);
