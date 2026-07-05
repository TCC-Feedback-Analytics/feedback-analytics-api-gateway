import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {
  catalogItems,
  collectionPoints,
  feedbackQuestionSubquestions,
  questionsOfFeedbacks,
} from '../../drizzle/schema.js';

// Drizzle ignora a RLS → toda query filtra enterprise_id explicitamente (invariante nº1).

type Database = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export type CatalogKind = 'PRODUCT' | 'SERVICE' | 'DEPARTMENT';
export type QuestionOrder = 1 | 2 | 3;
export type SubquestionOrder = 1 | 2 | 3;

export type CatalogQuestionSnapshot = {
  id: string;
  question_order: QuestionOrder;
  question_text: string;
  is_active: boolean;
  subquestions: Array<{
    id: string;
    question_id: string;
    subquestion_order: SubquestionOrder;
    subquestion_text: string;
    is_active: boolean;
  }>;
};

/** Falha ao ativar/criar um ponto QR — o controller mapeia ao 500 tipado certo. */
export class QrPointWriteError extends Error {
  constructor(public readonly reason: 'activate' | 'create') {
    super(reason);
    this.name = 'QrPointWriteError';
  }
}

// ----------------------------------------------------------------------------
// Snapshot das perguntas ATIVAS por item de catálogo (editor do QR)
// ----------------------------------------------------------------------------

export async function getCatalogQuestionsSnapshot(params: {
  enterpriseId: string;
  kind: CatalogKind;
  catalogItemIds: string[];
}): Promise<Map<string, CatalogQuestionSnapshot[]>> {
  const { enterpriseId, kind, catalogItemIds } = params;
  const snapshotByCatalogItem = new Map<string, CatalogQuestionSnapshot[]>();

  if (catalogItemIds.length === 0) return snapshotByCatalogItem;

  // Só perguntas ATIVAS alimentam o editor (soft-delete deixa o slot vazio aqui).
  const questionRows = await getDb()
    .select({
      id: questionsOfFeedbacks.id,
      catalogItemId: questionsOfFeedbacks.catalogItemId,
      questionOrder: questionsOfFeedbacks.questionOrder,
      questionText: questionsOfFeedbacks.questionText,
      isActive: questionsOfFeedbacks.isActive,
    })
    .from(questionsOfFeedbacks)
    .where(
      and(
        eq(questionsOfFeedbacks.enterpriseId, enterpriseId),
        eq(questionsOfFeedbacks.scopeType, kind),
        eq(questionsOfFeedbacks.isActive, true),
        inArray(questionsOfFeedbacks.catalogItemId, catalogItemIds),
      ),
    )
    .orderBy(asc(questionsOfFeedbacks.questionOrder));

  const normalized = questionRows
    .filter((row): row is typeof row & { catalogItemId: string } => typeof row.catalogItemId === 'string')
    .map((row) => ({
      id: row.id,
      catalogItemId: row.catalogItemId,
      question_order: Number(row.questionOrder) as QuestionOrder,
      question_text: String(row.questionText ?? ''),
      is_active: row.isActive === true,
    }));

  const questionIds = normalized.map((q) => q.id);
  const subquestionsByQuestionId = new Map<string, CatalogQuestionSnapshot['subquestions']>();

  if (questionIds.length > 0) {
    const subRows = await getDb()
      .select({
        id: feedbackQuestionSubquestions.id,
        questionId: feedbackQuestionSubquestions.questionId,
        subquestionOrder: feedbackQuestionSubquestions.subquestionOrder,
        subquestionText: feedbackQuestionSubquestions.subquestionText,
        isActive: feedbackQuestionSubquestions.isActive,
      })
      .from(feedbackQuestionSubquestions)
      .where(
        and(
          eq(feedbackQuestionSubquestions.isActive, true),
          inArray(feedbackQuestionSubquestions.questionId, questionIds),
        ),
      )
      .orderBy(asc(feedbackQuestionSubquestions.subquestionOrder));

    for (const row of subRows) {
      const current = subquestionsByQuestionId.get(row.questionId) ?? [];
      current.push({
        id: row.id,
        question_id: row.questionId,
        subquestion_order: Number(row.subquestionOrder) as SubquestionOrder,
        subquestion_text: String(row.subquestionText ?? ''),
        is_active: row.isActive === true,
      });
      subquestionsByQuestionId.set(row.questionId, current);
    }
  }

  for (const question of normalized) {
    const current = snapshotByCatalogItem.get(question.catalogItemId) ?? [];
    current.push({
      id: question.id,
      question_order: question.question_order,
      question_text: question.question_text,
      is_active: question.is_active,
      subquestions: (subquestionsByQuestionId.get(question.id) ?? []).sort(
        (a, b) => a.subquestion_order - b.subquestion_order,
      ),
    });
    snapshotByCatalogItem.set(question.catalogItemId, current);
  }

  snapshotByCatalogItem.forEach((questions, catalogItemId) => {
    snapshotByCatalogItem.set(
      catalogItemId,
      questions.sort((a, b) => a.question_order - b.question_order),
    );
  });

  return snapshotByCatalogItem;
}

// ----------------------------------------------------------------------------
// Leituras de catálogo / pontos de coleta
// ----------------------------------------------------------------------------

export interface CatalogItemRow {
  id: string;
  kind: string;
  name: string;
  status: string;
}

export async function getCatalogItemForEnterprise(
  enterpriseId: string,
  catalogItemId: string,
): Promise<CatalogItemRow | null> {
  const rows = await getDb()
    .select({ id: catalogItems.id, kind: catalogItems.kind, name: catalogItems.name, status: catalogItems.status })
    .from(catalogItems)
    .where(and(eq(catalogItems.id, catalogItemId), eq(catalogItems.enterpriseId, enterpriseId)))
    .limit(1);
  return rows[0] ?? null;
}

export interface CatalogListItem {
  id: string;
  name: string;
  description: string | null;
  kind: string;
}

export async function listActiveCatalogItems(
  enterpriseId: string,
  kind: CatalogKind,
): Promise<CatalogListItem[]> {
  return getDb()
    .select({
      id: catalogItems.id,
      name: catalogItems.name,
      description: catalogItems.description,
      kind: catalogItems.kind,
    })
    .from(catalogItems)
    .where(
      and(
        eq(catalogItems.enterpriseId, enterpriseId),
        eq(catalogItems.kind, kind),
        eq(catalogItems.status, 'ACTIVE'),
      ),
    )
    .orderBy(asc(catalogItems.sortOrder), asc(catalogItems.createdAt));
}

export interface QrPointRow {
  id: string;
  catalogItemId: string | null;
  status: string;
}

export async function findQrPointsForCatalogItems(
  enterpriseId: string,
  catalogItemIds: string[],
): Promise<QrPointRow[]> {
  if (catalogItemIds.length === 0) return [];
  return getDb()
    .select({
      id: collectionPoints.id,
      catalogItemId: collectionPoints.catalogItemId,
      status: collectionPoints.status,
    })
    .from(collectionPoints)
    .where(
      and(
        eq(collectionPoints.enterpriseId, enterpriseId),
        eq(collectionPoints.type, 'QR_CODE'),
        inArray(collectionPoints.catalogItemId, catalogItemIds),
      ),
    )
    .orderBy(desc(collectionPoints.updatedAt), desc(collectionPoints.createdAt));
}

export async function findActiveCompanyQrPoint(enterpriseId: string): Promise<{ id: string } | null> {
  const rows = await getDb()
    .select({ id: collectionPoints.id })
    .from(collectionPoints)
    .where(
      and(
        eq(collectionPoints.enterpriseId, enterpriseId),
        eq(collectionPoints.type, 'QR_CODE'),
        isNull(collectionPoints.catalogItemId),
        eq(collectionPoints.status, 'ACTIVE'),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// ----------------------------------------------------------------------------
// Escritas de pontos QR (company e por item de catálogo)
// ----------------------------------------------------------------------------

/** Ativa o QR "geral" (company): reusa o ativo, reativa um inativo, ou cria. */
export async function activateOrCreateCompanyQr(enterpriseId: string): Promise<{ id: string }> {
  const db = getDb();

  const active = await findActiveCompanyQrPoint(enterpriseId);
  if (active) return active;

  const any = await db
    .select({ id: collectionPoints.id })
    .from(collectionPoints)
    .where(
      and(
        eq(collectionPoints.enterpriseId, enterpriseId),
        eq(collectionPoints.type, 'QR_CODE'),
        isNull(collectionPoints.catalogItemId),
      ),
    )
    .limit(1);

  if (any[0]) {
    try {
      await db
        .update(collectionPoints)
        .set({ status: 'ACTIVE', name: 'QR Code' })
        .where(eq(collectionPoints.id, any[0].id));
    } catch {
      throw new QrPointWriteError('activate');
    }
    return { id: any[0].id };
  }

  try {
    const inserted = await db
      .insert(collectionPoints)
      .values({ enterpriseId, type: 'QR_CODE', status: 'ACTIVE', name: 'QR Code', catalogItemId: null })
      .returning({ id: collectionPoints.id });
    if (!inserted[0]) throw new QrPointWriteError('create');
    return inserted[0];
  } catch (err) {
    if (err instanceof QrPointWriteError) throw err;
    throw new QrPointWriteError('create');
  }
}

/** Desativa o QR "geral" ativo (no-op se não houver). */
export async function deactivateCompanyQr(enterpriseId: string): Promise<void> {
  const active = await findActiveCompanyQrPoint(enterpriseId);
  if (!active) return;
  await getDb().update(collectionPoints).set({ status: 'INACTIVE' }).where(eq(collectionPoints.id, active.id));
}

/** Ativa o QR de um item de catálogo: reusa o ativo, reativa o mais recente, ou cria. */
export async function activateOrCreateCatalogQr(
  enterpriseId: string,
  catalogItem: { id: string; name: string },
): Promise<{ id: string }> {
  const db = getDb();

  const active = await db
    .select({ id: collectionPoints.id })
    .from(collectionPoints)
    .where(
      and(
        eq(collectionPoints.enterpriseId, enterpriseId),
        eq(collectionPoints.type, 'QR_CODE'),
        eq(collectionPoints.catalogItemId, catalogItem.id),
        eq(collectionPoints.status, 'ACTIVE'),
      ),
    )
    .limit(1);
  if (active[0]) return active[0];

  const any = await db
    .select({ id: collectionPoints.id })
    .from(collectionPoints)
    .where(
      and(
        eq(collectionPoints.enterpriseId, enterpriseId),
        eq(collectionPoints.type, 'QR_CODE'),
        eq(collectionPoints.catalogItemId, catalogItem.id),
      ),
    )
    .orderBy(desc(collectionPoints.updatedAt), desc(collectionPoints.createdAt))
    .limit(1);

  if (any[0]) {
    try {
      await db
        .update(collectionPoints)
        .set({ status: 'ACTIVE', name: `QR Code - ${catalogItem.name}` })
        .where(eq(collectionPoints.id, any[0].id));
    } catch {
      throw new QrPointWriteError('activate');
    }
    return { id: any[0].id };
  }

  try {
    const inserted = await db
      .insert(collectionPoints)
      .values({
        enterpriseId,
        catalogItemId: catalogItem.id,
        type: 'QR_CODE',
        status: 'ACTIVE',
        name: `QR Code - ${catalogItem.name}`,
      })
      .returning({ id: collectionPoints.id });
    if (!inserted[0]) throw new QrPointWriteError('create');
    return inserted[0];
  } catch (err) {
    if (err instanceof QrPointWriteError) throw err;
    throw new QrPointWriteError('create');
  }
}

/** Desativa TODOS os QR ativos de um item de catálogo. */
export async function deactivateCatalogQr(enterpriseId: string, catalogItemId: string): Promise<void> {
  await getDb()
    .update(collectionPoints)
    .set({ status: 'INACTIVE' })
    .where(
      and(
        eq(collectionPoints.enterpriseId, enterpriseId),
        eq(collectionPoints.type, 'QR_CODE'),
        eq(collectionPoints.catalogItemId, catalogItemId),
        eq(collectionPoints.status, 'ACTIVE'),
      ),
    );
}

// ----------------------------------------------------------------------------
// Escrita transacional das perguntas de um item de catálogo
// ----------------------------------------------------------------------------

export interface NormalizedCatalogSubquestion {
  subquestion_order: SubquestionOrder;
  subquestion_text: string;
  is_active: boolean;
}

export interface NormalizedCatalogQuestion {
  question_order: QuestionOrder;
  question_text: string;
  is_active: boolean;
  subquestionsByOrder: Map<SubquestionOrder, NormalizedCatalogSubquestion>;
}

const MIN_QUESTION_LENGTH = 20;
const MAX_QUESTION_LENGTH = 150;

function hasValidQuestionLength(value: string) {
  return value.length >= MIN_QUESTION_LENGTH && value.length <= MAX_QUESTION_LENGTH;
}

async function deactivateCatalogQuestionSlotTx(
  tx: Tx,
  params: { enterpriseId: string; kind: CatalogKind; catalogItemId: string; questionOrder: QuestionOrder },
): Promise<void> {
  const existing = await tx
    .select({ id: questionsOfFeedbacks.id })
    .from(questionsOfFeedbacks)
    .where(
      and(
        eq(questionsOfFeedbacks.enterpriseId, params.enterpriseId),
        eq(questionsOfFeedbacks.scopeType, params.kind),
        eq(questionsOfFeedbacks.catalogItemId, params.catalogItemId),
        eq(questionsOfFeedbacks.questionOrder, params.questionOrder),
      ),
    );
  const existingId = existing[0]?.id;
  if (!existingId) return;

  const nowIso = new Date().toISOString();
  await tx
    .update(feedbackQuestionSubquestions)
    .set({ isActive: false, updatedAt: nowIso })
    .where(eq(feedbackQuestionSubquestions.questionId, existingId));
  await tx
    .update(questionsOfFeedbacks)
    .set({ isActive: false, updatedAt: nowIso })
    .where(eq(questionsOfFeedbacks.id, existingId));
}

/**
 * Persiste as perguntas de um item de catálogo (contagem variável 1–3, soft-delete
 * dos slots vazios) numa ÚNICA transação — o fluxo Supabase fazia writes soltos.
 * Qualquer falha faz rollback. Textos já vêm validados (20–150) do controller.
 */
export async function saveCatalogQuestions(params: {
  enterpriseId: string;
  kind: CatalogKind;
  catalogItemId: string;
  questions: NormalizedCatalogQuestion[];
}): Promise<void> {
  const { enterpriseId, kind, catalogItemId, questions } = params;

  await getDb().transaction(async (tx) => {
    for (const question of questions) {
      if (!hasValidQuestionLength(question.question_text)) {
        await deactivateCatalogQuestionSlotTx(tx, { enterpriseId, kind, catalogItemId, questionOrder: question.question_order });
        continue;
      }

      const nowIso = new Date().toISOString();

      const updated = await tx
        .update(questionsOfFeedbacks)
        .set({ questionText: question.question_text, isActive: true, updatedAt: nowIso })
        .where(
          and(
            eq(questionsOfFeedbacks.enterpriseId, enterpriseId),
            eq(questionsOfFeedbacks.scopeType, kind),
            eq(questionsOfFeedbacks.catalogItemId, catalogItemId),
            eq(questionsOfFeedbacks.questionOrder, question.question_order),
          ),
        )
        .returning({ id: questionsOfFeedbacks.id });

      let questionId = updated[0]?.id;

      if (!questionId) {
        const inserted = await tx
          .insert(questionsOfFeedbacks)
          .values({
            enterpriseId,
            scopeType: kind,
            catalogItemId,
            questionOrder: question.question_order,
            questionText: question.question_text,
            isActive: true,
          })
          .returning({ id: questionsOfFeedbacks.id });
        questionId = inserted[0]?.id;
        if (!questionId) throw new Error('catalog question insert returned no id');
      }

      for (const subquestionOrder of [1, 2, 3] as SubquestionOrder[]) {
        const subquestion = question.subquestionsByOrder.get(subquestionOrder);

        if (!subquestion || subquestion.subquestion_text.length === 0) {
          await tx
            .update(feedbackQuestionSubquestions)
            .set({ isActive: false, updatedAt: new Date().toISOString() })
            .where(
              and(
                eq(feedbackQuestionSubquestions.questionId, questionId),
                eq(feedbackQuestionSubquestions.subquestionOrder, subquestionOrder),
              ),
            );
          continue;
        }

        const updatedSub = await tx
          .update(feedbackQuestionSubquestions)
          .set({ subquestionText: subquestion.subquestion_text, isActive: true, updatedAt: new Date().toISOString() })
          .where(
            and(
              eq(feedbackQuestionSubquestions.questionId, questionId),
              eq(feedbackQuestionSubquestions.subquestionOrder, subquestion.subquestion_order),
            ),
          )
          .returning({ id: feedbackQuestionSubquestions.id });

        if (updatedSub.length > 0) continue;

        await tx.insert(feedbackQuestionSubquestions).values({
          questionId,
          subquestionOrder: subquestion.subquestion_order,
          subquestionText: subquestion.subquestion_text,
          isActive: true,
        });
      }
    }
  });
}
