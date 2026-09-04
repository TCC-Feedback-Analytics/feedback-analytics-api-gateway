/**
 * Lote sintético de 100 feedbacks, somente na fixture de teste do Docker local.
 * Inspeção sem escrita: node scripts/seed-raw-feedbacks.mjs
 * Inserção:            node scripts/seed-raw-feedbacks.mjs --apply
 * IDs determinísticos: repetir o comando não duplica nem reseta análises.
 * Não cria usuários, não altera credenciais e não dispara jobs/LLM.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import postgres from 'postgres';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/raw-feedbacks-restaurant-100.json', import.meta.url), 'utf8'));
const env = parse(readFileSync(new URL('../.env', import.meta.url), 'utf8'));
const apply = process.argv.includes('--apply');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function feedbackId(index) {
  const digest = createHash('sha1').update(`${fixture.batchId}:${fixture.enterpriseId}:${index}`).digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function main() {
  assert(process.argv.slice(2).every((arg) => arg === '--apply'), 'Argumento não reconhecido.');
  const target = new URL(env.DATABASE_URL);
  assert(target.hostname === '127.0.0.1' && target.port === '5433' && target.pathname === '/feedback',
    'Alvo recusado: este lote só pode ser inserido no Docker local 127.0.0.1:5433/feedback.');
  assert(env.E2E_TEST_EMAIL === fixture.accountEmail && env.E2E_TEST_ENTERPRISE_ID === fixture.enterpriseId,
    'A conta de teste configurada não corresponde à fixture.');
  assert(fixture.feedbacks.length === 100, 'O lote deve ter exatamente 100 feedbacks.');
  assert(new Set(fixture.feedbacks.map((entry) => entry.message)).size === 100, 'Existem comentários duplicados.');
  for (const entry of fixture.feedbacks) {
    assert(typeof entry.message === 'string' && entry.message.trim().length >= 20, 'Comentário inválido.');
    assert(Number.isInteger(entry.rating) && entry.rating >= 1 && entry.rating <= 5, 'Nota inválida.');
  }

  const rows = fixture.feedbacks.map((entry, index) => ({
    id: feedbackId(index), enterprise_id: fixture.enterpriseId, collection_point_id: fixture.collectionPointId,
    rating: entry.rating, message: entry.message,
  }));
  const ids = rows.map((row) => row.id);
  const db = postgres(env.DATABASE_URL, { max: 1, connect_timeout: 5 });
  try {
    const result = await db.begin(apply ? 'isolation level serializable' : 'read only', async (sql) => {
      const account = await sql`
        SELECT u.email, u.name FROM public.enterprise e
        JOIN public."user" u ON u.id = e.auth_user_id
        WHERE e.id = ${fixture.enterpriseId}::uuid AND lower(u.email) = lower(${fixture.accountEmail})`;
      assert(account.length === 1, 'Vínculo entre a conta de teste e a empresa não encontrado.');
      const points = await sql`
        SELECT id, name FROM public.collection_points
        WHERE enterprise_id = ${fixture.enterpriseId}::uuid AND id = ${fixture.collectionPointId}::uuid
          AND catalog_item_id IS NULL AND status = 'ACTIVE'`;
      assert(points.length === 1, 'Ponto de coleta geral ativo não encontrado para esta empresa.');
      const jobs = await sql`
        SELECT id FROM public.ia_analysis_job WHERE enterprise_id = ${fixture.enterpriseId}::uuid
          AND status IN ('queued', 'running', 'waiting_budget')`;
      assert(jobs.length === 0, 'Há uma análise ativa. Aguarde sua conclusão antes de inserir o lote cru.');

      const existing = await sql`
        SELECT id, message, rating, collection_point_id FROM public.feedback
        WHERE enterprise_id = ${fixture.enterpriseId}::uuid AND id = ANY(${ids}::uuid[])`;
      for (const entry of existing) {
        const expected = rows.find((row) => row.id === entry.id);
        assert(expected && entry.message === expected.message && entry.rating === expected.rating &&
          entry.collection_point_id === expected.collection_point_id,
        'Um ID do lote já existe com conteúdo diferente; nenhum registro será sobrescrito.');
      }
      const before = await sql`
        SELECT count(*)::int AS total,
          count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.feedback_analysis a WHERE a.feedback_id = f.id))::int AS raw
        FROM public.feedback f WHERE enterprise_id = ${fixture.enterpriseId}::uuid`;

      let inserted = [];
      if (apply) {
        inserted = await sql`INSERT INTO public.feedback ${sql(rows)} ON CONFLICT (id) DO NOTHING RETURNING id`;
        const verified = await sql`
          SELECT count(*)::int AS total,
            count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.feedback_analysis a WHERE a.feedback_id = f.id))::int AS raw
          FROM public.feedback f WHERE enterprise_id = ${fixture.enterpriseId}::uuid AND id = ANY(${ids}::uuid[])`;
        assert(verified[0].total === 100, 'A conferência do lote falhou; revertendo a transação.');
        assert(verified[0].raw >= inserted.length, 'A inserção não deixou os novos registros crus.');
      }

      const after = await sql`
        SELECT count(*)::int AS total,
          count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.feedback_analysis a WHERE a.feedback_id = f.id))::int AS raw
        FROM public.feedback f WHERE enterprise_id = ${fixture.enterpriseId}::uuid`;
      assert(after[0].total === before[0].total + inserted.length, 'Contagem inesperada; revertendo a transação.');
      assert(after[0].raw === before[0].raw + inserted.length, 'Contagem de feedbacks crus inesperada; revertendo.');
      return {
        mode: apply ? 'applied' : 'dry-run', batch: fixture.batchId, account: account[0].email,
        collectionPoint: points[0].name, existingInBatch: existing.length,
        toInsert: 100 - existing.length, inserted: inserted.length, before: before[0], after: after[0],
        ratings: Object.fromEntries([1, 2, 3, 4, 5].map((rating) => [rating, rows.filter((row) => row.rating === rating).length])),
      };
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await db.end({ timeout: 5 });
  }
}

main().catch((error) => {
  // Não imprimir erros do driver com parâmetros de conexão ou conteúdo de SQL.
  console.error('Não foi possível preparar o lote:', error instanceof Error && error.constructor === Error ? error.message : 'Falha de banco; nenhuma escrita parcial foi mantida.');
  process.exitCode = 1;
});
