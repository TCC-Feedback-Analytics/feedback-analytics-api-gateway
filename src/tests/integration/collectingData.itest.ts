import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, closeDb } from '../../db/client.js';
import {
  CollectingWriteError,
  getCatalogSnapshot,
  getCollectingDataByEnterprise,
  getCompanyQuestionsSnapshot,
  getEnterpriseByUser,
  saveCollectingDataPatch,
  saveCollectingDataUpsert,
  updateEnterpriseByUser,
  type NormalizedCompanyQuestion,
  type NormalizedCompanySubquestion,
  type SyncPlan,
} from '../../repositories/collectingData.repository.js';

// Empresa C hermética (fora do seed A/B) — mutações livres sem afetar outros itests.
const C_USER = 'cccccccc-1111-1111-1111-111111111111';
const C_ENT = 'cccccccc-2222-2222-2222-222222222222';
const C_DOC = 'ITEST-COLLECTING-99';

function q(order: 1 | 2 | 3, text: string, subs: NormalizedCompanySubquestion[] = []): NormalizedCompanyQuestion {
  const m = new Map<1 | 2 | 3, NormalizedCompanySubquestion>();
  for (const s of subs) m.set(s.subquestion_order, s);
  return { question_order: order, question_text: text, is_active: true, subquestionsByOrder: m };
}

const THREE_QUESTIONS: NormalizedCompanyQuestion[] = [
  q(1, 'Como você avalia o atendimento recebido hoje aqui?'),
  q(2, 'Como você avalia a qualidade geral dos produtos?'),
  q(3, 'A relação entre preço e qualidade foi satisfatória?'),
];

function emptyCatalogPlan(): SyncPlan['catalog'] {
  return [
    { kind: 'PRODUCT', run: false, items: [], disableAll: false },
    { kind: 'SERVICE', run: false, items: [], disableAll: false },
    { kind: 'DEPARTMENT', run: false, items: [], disableAll: false },
  ];
}

beforeAll(async () => {
  const db = getDb();
  await db.execute(sql`
    INSERT INTO public."user" (id, email, name, email_verified)
    VALUES (${C_USER}, 'itest-collecting@x.local', 'Gestor C', true)
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO public.enterprise (id, auth_user_id, document, account_type, terms_version, terms_accepted_at, trial_ends_at, subscription_status)
    VALUES (${C_ENT}, ${C_USER}, ${C_DOC}, 'CNPJ', 'v1', now(), now() + interval '4 months', 'TRIAL')
    ON CONFLICT (id) DO NOTHING
  `);
});

// Cada teste começa com os dados mutáveis de C zerados (perfil da empresa é preservado).
beforeEach(async () => {
  const db = getDb();
  await db.execute(sql`DELETE FROM public.questions_of_feedbacks WHERE enterprise_id = ${C_ENT}`);
  await db.execute(sql`DELETE FROM public.catalog_items WHERE enterprise_id = ${C_ENT}`);
  await db.execute(sql`DELETE FROM public.collecting_data_enterprise WHERE enterprise_id = ${C_ENT}`);
});

afterAll(async () => {
  // Limpeza explícita: filhos → enterprise → public.user.
  const db = getDb();
  await db.execute(sql`DELETE FROM public.questions_of_feedbacks WHERE enterprise_id = ${C_ENT}`);
  await db.execute(sql`DELETE FROM public.catalog_items WHERE enterprise_id = ${C_ENT}`);
  await db.execute(sql`DELETE FROM public.collecting_data_enterprise WHERE enterprise_id = ${C_ENT}`);
  await db.execute(sql`DELETE FROM public.enterprise WHERE id = ${C_ENT}`);
  await db.execute(sql`DELETE FROM public."user" WHERE id = ${C_USER}`);
  await closeDb();
});

describe('[Integração] empresa (perfil) — get/patch por usuário', () => {
  it('getEnterpriseByUser retorna o perfil em snake_case', async () => {
    const ent = await getEnterpriseByUser(C_USER);
    expect(ent).not.toBeNull();
    expect(ent?.id).toBe(C_ENT);
    expect(ent?.document).toBe(C_DOC);
    expect(ent?.account_type).toBe('CNPJ');
    expect(ent?.subscription_status).toBe('TRIAL');
  });

  it('getEnterpriseByUser => null p/ usuário sem empresa', async () => {
    expect(await getEnterpriseByUser('00000000-0000-0000-0000-0000000000ff')).toBeNull();
  });

  it('updateEnterpriseByUser aplica só as chaves presentes e devolve a linha', async () => {
    const updated = await updateEnterpriseByUser(C_USER, { account_type: 'CPF' });
    expect(updated?.account_type).toBe('CPF');
    expect(updated?.document).toBe(C_DOC); // inalterado
    // restaura para não vazar entre testes
    await updateEnterpriseByUser(C_USER, { account_type: 'CNPJ' });
  });
});

describe('[Integração] collecting_data — upsert + syncs (transacional)', () => {
  it('saveCollectingDataUpsert cria collecting + catálogo + 3 perguntas COMPANY', async () => {
    const plan: SyncPlan = {
      catalog: [
        { kind: 'PRODUCT', run: true, items: [{ name: 'Prod A', description: null, sortOrder: 0, status: 'ACTIVE' }], disableAll: false },
        { kind: 'SERVICE', run: true, items: [], disableAll: false },
        { kind: 'DEPARTMENT', run: true, items: [], disableAll: false },
      ],
      questions: THREE_QUESTIONS,
    };

    const collecting = await saveCollectingDataUpsert({
      enterpriseId: C_ENT,
      values: { companyObjective: 'Objetivo C', usesCompanyProducts: true },
      plan,
    });

    expect(collecting.enterprise_id).toBe(C_ENT);
    expect(collecting.company_objective).toBe('Objetivo C');
    expect(collecting.uses_company_products).toBe(true);

    const catalog = await getCatalogSnapshot(C_ENT);
    expect(catalog.catalog_products).toHaveLength(1);
    expect(catalog.catalog_products[0]?.name).toBe('Prod A');
    expect(catalog.catalog_services).toHaveLength(0);

    const questions = await getCompanyQuestionsSnapshot(C_ENT);
    expect(questions).toHaveLength(3);
    expect(questions.map((x) => x.question_order)).toEqual([1, 2, 3]);
  });

  it('catálogo: update do existente, insert do novo e soft-delete do ausente (INACTIVE)', async () => {
    // Semeia 2 produtos.
    await saveCollectingDataUpsert({
      enterpriseId: C_ENT,
      values: { usesCompanyProducts: true },
      plan: {
        catalog: [
          { kind: 'PRODUCT', run: true, items: [
            { name: 'P1', description: null, sortOrder: 0, status: 'ACTIVE' },
            { name: 'P2', description: null, sortOrder: 1, status: 'ACTIVE' },
          ], disableAll: false },
          { kind: 'SERVICE', run: true, items: [], disableAll: false },
          { kind: 'DEPARTMENT', run: true, items: [], disableAll: false },
        ],
        questions: THREE_QUESTIONS,
      },
    });

    const seeded = await getCatalogSnapshot(C_ENT);
    const p1 = seeded.catalog_products.find((x) => x.name === 'P1')!;
    expect(p1).toBeTruthy();

    // Patch: renomeia P1 (por id), adiciona P3 (novo), omite P2 (deve virar INACTIVE).
    await saveCollectingDataPatch({
      enterpriseId: C_ENT,
      update: { usesCompanyProducts: true },
      insert: { usesCompanyProducts: true },
      plan: {
        catalog: [
          { kind: 'PRODUCT', run: true, items: [
            { id: p1.id, name: 'P1 renomeado', description: null, sortOrder: 0, status: 'ACTIVE' },
            { name: 'P3', description: null, sortOrder: 2, status: 'ACTIVE' },
          ], disableAll: false },
          { kind: 'SERVICE', run: false, items: [], disableAll: false },
          { kind: 'DEPARTMENT', run: false, items: [], disableAll: false },
        ],
        questions: null,
      },
    });

    const after = await getCatalogSnapshot(C_ENT); // só ACTIVE
    const activeNames = after.catalog_products.map((x) => x.name).sort();
    expect(activeNames).toEqual(['P1 renomeado', 'P3']); // P2 sumiu (INACTIVE)

    // P2 continua no banco, porém INACTIVE.
    const p2rows = await getDb().execute(
      sql`SELECT status FROM public.catalog_items WHERE enterprise_id = ${C_ENT} AND name = 'P2'`,
    );
    expect((p2rows[0] as { status: string }).status).toBe('INACTIVE');
  });

  it('perguntas: subpergunta ausente vira INACTIVE (soft-delete), snapshot mostra inativa', async () => {
    const sub: NormalizedCompanySubquestion = {
      subquestion_order: 1,
      subquestion_text: 'Subpergunta ativa com texto suficientemente longo?',
      is_active: true,
    };
    // Cria Q1 com uma subpergunta ativa.
    await saveCollectingDataUpsert({
      enterpriseId: C_ENT,
      values: {},
      plan: { catalog: emptyCatalogPlan().map((s) => ({ ...s, run: true })), questions: [q(1, 'Pergunta 1 com texto suficientemente longo aqui?', [sub]), THREE_QUESTIONS[1], THREE_QUESTIONS[2]] },
    });

    let snap = await getCompanyQuestionsSnapshot(C_ENT);
    const q1 = snap.find((x) => x.question_order === 1)!;
    expect(q1.subquestions.find((s) => s.subquestion_order === 1)?.is_active).toBe(true);

    // Patch Q1 SEM a subpergunta → deve desativar (não apagar).
    await saveCollectingDataPatch({
      enterpriseId: C_ENT,
      update: {},
      insert: {},
      plan: { catalog: emptyCatalogPlan(), questions: [q(1, 'Pergunta 1 com texto suficientemente longo aqui?'), THREE_QUESTIONS[1], THREE_QUESTIONS[2]] },
    });

    snap = await getCompanyQuestionsSnapshot(C_ENT);
    const q1after = snap.find((x) => x.question_order === 1)!;
    const sub1 = q1after.subquestions.find((s) => s.subquestion_order === 1);
    expect(sub1).toBeTruthy(); // preservada
    expect(sub1?.is_active).toBe(false); // desativada
  });
});

describe('[Integração] collecting_data — atomicidade da transação', () => {
  it('ROLLBACK: falha no sync de perguntas desfaz o update do collecting', async () => {
    // Estado inicial conhecido.
    await saveCollectingDataUpsert({
      enterpriseId: C_ENT,
      values: { companyObjective: 'ANTES' },
      plan: { catalog: emptyCatalogPlan().map((s) => ({ ...s, run: true })), questions: THREE_QUESTIONS },
    });

    // Pergunta com texto curto demais viola o CHECK (20–150 chars) no INSERT/UPDATE.
    const badQuestions: NormalizedCompanyQuestion[] = [q(1, 'curto'), THREE_QUESTIONS[1], THREE_QUESTIONS[2]];

    await expect(
      saveCollectingDataPatch({
        enterpriseId: C_ENT,
        update: { companyObjective: 'DEPOIS' },
        insert: { companyObjective: 'DEPOIS' },
        plan: { catalog: emptyCatalogPlan(), questions: badQuestions },
      }),
    ).rejects.toBeInstanceOf(CollectingWriteError);

    // O update do collecting foi revertido junto com o sync — permanece 'ANTES'.
    const row = await getCollectingDataByEnterprise(C_ENT);
    expect(row?.company_objective).toBe('ANTES');
  });
});
