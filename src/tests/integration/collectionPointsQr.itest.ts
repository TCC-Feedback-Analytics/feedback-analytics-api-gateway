import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, closeDb } from '../../db/client.js';
import {
  activateOrCreateCatalogQr,
  activateOrCreateCompanyQr,
  deactivateCatalogQr,
  deactivateCompanyQr,
  findActiveCompanyQrPoint,
  findQrPointsForCatalogItems,
  getCatalogItemForEnterprise,
  getCatalogQuestionsSnapshot,
  listActiveCatalogItems,
  saveCatalogQuestions,
  type NormalizedCatalogQuestion,
  type NormalizedCatalogSubquestion,
  type QuestionOrder,
} from '../../repositories/collectionPointsQr.repository.js';

// Empresa D hermética (separada de A/B do seed e da C do collecting).
const D_USER = 'dddddddd-1111-1111-1111-111111111111';
const D_ENT = 'dddddddd-2222-2222-2222-222222222222';
const D_ITEM = 'dddddddd-3333-3333-3333-333333333333';
const D_DOC = 'ITEST-CPQR-77';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';

const LONG = 'Texto de pergunta suficientemente longo para o CHECK';

function sub(order: 1 | 2 | 3, text: string): NormalizedCatalogSubquestion {
  return { subquestion_order: order, subquestion_text: text, is_active: text.length > 0 };
}

function q(order: QuestionOrder, text: string, subs: NormalizedCatalogSubquestion[] = []): NormalizedCatalogQuestion {
  const m = new Map<1 | 2 | 3, NormalizedCatalogSubquestion>();
  for (const s of subs) m.set(s.subquestion_order, s);
  return { question_order: order, question_text: text, is_active: text.length > 0, subquestionsByOrder: m };
}

beforeAll(async () => {
  const db = getDb();
  await db.execute(sql`
    INSERT INTO public."user" (id, email, name, email_verified)
    VALUES (${D_USER}, 'itest-cpqr@x.local', 'Gestor D', true)
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO public.enterprise (id, auth_user_id, document, account_type, terms_version, terms_accepted_at, trial_ends_at, subscription_status)
    VALUES (${D_ENT}, ${D_USER}, ${D_DOC}, 'CNPJ', 'v1', now(), now() + interval '4 months', 'TRIAL')
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO public.catalog_items (id, enterprise_id, kind, name, status, sort_order)
    VALUES (${D_ITEM}, ${D_ENT}, 'PRODUCT', 'Produto D', 'ACTIVE', 0)
    ON CONFLICT (id) DO NOTHING
  `);
});

beforeEach(async () => {
  const db = getDb();
  await db.execute(sql`DELETE FROM public.collection_points WHERE enterprise_id = ${D_ENT}`);
  await db.execute(sql`DELETE FROM public.questions_of_feedbacks WHERE enterprise_id = ${D_ENT}`);
});

afterAll(async () => {
  const db = getDb();
  await db.execute(sql`DELETE FROM public.collection_points WHERE enterprise_id = ${D_ENT}`);
  await db.execute(sql`DELETE FROM public.questions_of_feedbacks WHERE enterprise_id = ${D_ENT}`);
  await db.execute(sql`DELETE FROM public.catalog_items WHERE enterprise_id = ${D_ENT}`);
  await db.execute(sql`DELETE FROM public.enterprise WHERE id = ${D_ENT}`);
  await db.execute(sql`DELETE FROM public."user" WHERE id = ${D_USER}`);
  await closeDb();
});

describe('[Integração] ponto QR company (geral) — ativar/reusar/desativar', () => {
  it('cria, reusa o ativo e reativa após desativar (mesmo ponto)', async () => {
    expect(await findActiveCompanyQrPoint(D_ENT)).toBeNull();

    const created = await activateOrCreateCompanyQr(D_ENT);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await findActiveCompanyQrPoint(D_ENT))?.id).toBe(created.id);

    // Reusa o ponto já ativo (não cria outro).
    const again = await activateOrCreateCompanyQr(D_ENT);
    expect(again.id).toBe(created.id);

    await deactivateCompanyQr(D_ENT);
    expect(await findActiveCompanyQrPoint(D_ENT)).toBeNull();

    // Reativa o MESMO ponto (any → update), não cria um novo.
    const reactivated = await activateOrCreateCompanyQr(D_ENT);
    expect(reactivated.id).toBe(created.id);
  });
});

describe('[Integração] ponto QR por item de catálogo', () => {
  it('lista itens ativos, ativa/reusa/desativa o QR do item', async () => {
    const items = await listActiveCatalogItems(D_ENT, 'PRODUCT');
    expect(items.map((i) => i.id)).toContain(D_ITEM);

    const created = await activateOrCreateCatalogQr(D_ENT, { id: D_ITEM, name: 'Produto D' });
    const again = await activateOrCreateCatalogQr(D_ENT, { id: D_ITEM, name: 'Produto D' });
    expect(again.id).toBe(created.id); // reusa o ativo

    const points = await findQrPointsForCatalogItems(D_ENT, [D_ITEM]);
    expect(points.find((p) => p.catalogItemId === D_ITEM)?.status).toBe('ACTIVE');

    await deactivateCatalogQr(D_ENT, D_ITEM);
    const after = await findQrPointsForCatalogItems(D_ENT, [D_ITEM]);
    expect(after.find((p) => p.catalogItemId === D_ITEM)?.status).toBe('INACTIVE');

    // Reativa o MESMO ponto inativo (any → update), sem criar um segundo.
    const reactivated = await activateOrCreateCatalogQr(D_ENT, { id: D_ITEM, name: 'Produto D' });
    expect(reactivated.id).toBe(created.id);
    const points2 = await findQrPointsForCatalogItems(D_ENT, [D_ITEM]);
    expect(points2).toHaveLength(1);
    expect(points2[0]?.status).toBe('ACTIVE');
  });
});

describe('[Integração] saveCatalogQuestions — transacional, contagem variável', () => {
  it('cria pergunta ativa + subpergunta; slots vazios não geram linhas; snapshot só ativas', async () => {
    await saveCatalogQuestions({
      enterpriseId: D_ENT,
      kind: 'PRODUCT',
      catalogItemId: D_ITEM,
      questions: [q(1, `${LONG} 1?`, [sub(1, `${LONG} sub?`)]), q(2, ''), q(3, '')],
    });

    const snap = await getCatalogQuestionsSnapshot({ enterpriseId: D_ENT, kind: 'PRODUCT', catalogItemIds: [D_ITEM] });
    const list = snap.get(D_ITEM) ?? [];
    expect(list).toHaveLength(1);
    expect(list[0]?.question_order).toBe(1);
    expect(list[0]?.subquestions).toHaveLength(1);
  });

  it('re-save: atualiza texto, insere nova pergunta e desativa subpergunta removida', async () => {
    await saveCatalogQuestions({
      enterpriseId: D_ENT,
      kind: 'PRODUCT',
      catalogItemId: D_ITEM,
      questions: [q(1, `${LONG} 1?`, [sub(1, `${LONG} sub?`)]), q(2, ''), q(3, '')],
    });

    await saveCatalogQuestions({
      enterpriseId: D_ENT,
      kind: 'PRODUCT',
      catalogItemId: D_ITEM,
      questions: [q(1, `${LONG} 1 atualizada?`, []), q(2, `${LONG} 2 nova?`, []), q(3, '')],
    });

    const snap = await getCatalogQuestionsSnapshot({ enterpriseId: D_ENT, kind: 'PRODUCT', catalogItemIds: [D_ITEM] });
    const list = snap.get(D_ITEM) ?? [];
    expect(list.map((x) => x.question_order)).toEqual([1, 2]);
    const first = list.find((x) => x.question_order === 1)!;
    expect(first.question_text).toBe(`${LONG} 1 atualizada?`);
    expect(first.subquestions).toHaveLength(0); // subpergunta desativada
  });

  it('esvaziar todos os slots faz soft-delete (linhas ficam INACTIVE, não somem)', async () => {
    await saveCatalogQuestions({
      enterpriseId: D_ENT,
      kind: 'PRODUCT',
      catalogItemId: D_ITEM,
      questions: [q(1, `${LONG} 1?`), q(2, `${LONG} 2?`), q(3, '')],
    });

    await saveCatalogQuestions({
      enterpriseId: D_ENT,
      kind: 'PRODUCT',
      catalogItemId: D_ITEM,
      questions: [q(1, ''), q(2, ''), q(3, '')],
    });

    const snap = await getCatalogQuestionsSnapshot({ enterpriseId: D_ENT, kind: 'PRODUCT', catalogItemIds: [D_ITEM] });
    expect(snap.get(D_ITEM) ?? []).toHaveLength(0);

    // As linhas continuam no banco, porém inativas (histórico preservado).
    const rows = await getDb().execute(
      sql`SELECT count(*)::int AS n FROM public.questions_of_feedbacks WHERE enterprise_id = ${D_ENT} AND is_active = false`,
    );
    expect(Number((rows[0] as { n: number }).n)).toBeGreaterThanOrEqual(2);
  });
});

describe('[Integração] isolamento por tenant', () => {
  it('getCatalogItemForEnterprise não vaza item entre empresas', async () => {
    expect((await getCatalogItemForEnterprise(D_ENT, D_ITEM))?.id).toBe(D_ITEM);
    expect(await getCatalogItemForEnterprise(A, D_ITEM)).toBeNull();
  });
});
