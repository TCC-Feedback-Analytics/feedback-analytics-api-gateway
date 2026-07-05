import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {
  catalogItems,
  collectingDataEnterprise,
  enterprise,
  feedbackQuestionSubquestions,
  questionsOfFeedbacks,
} from '../../drizzle/schema.js';
import type { CatalogKind } from './collectionPointsQr.repository.js';

// Drizzle ignora a RLS → toda query filtra enterprise_id explicitamente (invariante nº1).

type Database = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Falha de escrita do bloco de dados de coleta → o controller mapeia p/ 400 upsert_failed. */
export class CollectingWriteError extends Error {
  constructor() {
    super('collecting_write_failed');
    this.name = 'CollectingWriteError';
  }
}

/** SQLSTATE do erro (percorre a cadeia .cause; DrizzleQueryError embrulha o erro do postgres-js). */
function pgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Violação de integridade (classe SQLSTATE 23xxx: CHECK, UNIQUE, FK, NOT NULL) =
 * dado inválido do cliente → vira CollectingWriteError (400). Erros de infra
 * (conexão, pool, bug) NÃO têm 23xxx e devem propagar como 500.
 */
function isIntegrityViolation(err: unknown): boolean {
  const code = pgErrorCode(err);
  return typeof code === 'string' && code.startsWith('23');
}

// ----------------------------------------------------------------------------
// Empresa (perfil) — get/patch
// ----------------------------------------------------------------------------

export interface EnterpriseProfile {
  id: string;
  document: string;
  account_type: string | null;
  terms_version: string | null;
  terms_accepted_at: string | null;
  created_at: string | null;
  trial_ends_at: string | null;
  subscription_status: string | null;
}

const enterpriseProfileColumns = {
  id: enterprise.id,
  document: enterprise.document,
  account_type: enterprise.accountType,
  terms_version: enterprise.termsVersion,
  terms_accepted_at: enterprise.termsAcceptedAt,
  created_at: enterprise.createdAt,
  trial_ends_at: enterprise.trialEndsAt,
  subscription_status: enterprise.subscriptionStatus,
};

export async function getEnterpriseByUser(userId: string): Promise<EnterpriseProfile | null> {
  const rows = await getDb()
    .select(enterpriseProfileColumns)
    .from(enterprise)
    .where(eq(enterprise.authUserId, userId))
    .limit(1);
  return rows[0] ?? null;
}

export interface EnterprisePatch {
  document?: string;
  account_type?: 'CPF' | 'CNPJ';
  terms_version?: string;
  terms_accepted_at?: string;
}

export async function updateEnterpriseByUser(
  userId: string,
  patch: EnterprisePatch,
): Promise<EnterpriseProfile | null> {
  const set: Record<string, unknown> = {};
  if (patch.document !== undefined) set.document = patch.document;
  if (patch.account_type !== undefined) set.accountType = patch.account_type;
  if (patch.terms_version !== undefined) set.termsVersion = patch.terms_version;
  if (patch.terms_accepted_at !== undefined) set.termsAcceptedAt = patch.terms_accepted_at;

  if (Object.keys(set).length === 0) {
    return getEnterpriseByUser(userId);
  }

  const rows = await getDb()
    .update(enterprise)
    .set(set)
    .where(eq(enterprise.authUserId, userId))
    .returning(enterpriseProfileColumns);
  return rows[0] ?? null;
}

// ----------------------------------------------------------------------------
// Dados de coleta (collecting_data_enterprise) — leitura
// ----------------------------------------------------------------------------

export interface CollectingRow {
  id: string;
  enterprise_id: string;
  company_objective: string | null;
  analytics_goal: string | null;
  business_summary: string | null;
  main_products_or_services: string[] | null;
  uses_company_products: boolean;
  uses_company_services: boolean;
  uses_company_departments: boolean;
  created_at: string | null;
  updated_at: string | null;
}

const collectingColumns = {
  id: collectingDataEnterprise.id,
  enterprise_id: collectingDataEnterprise.enterpriseId,
  company_objective: collectingDataEnterprise.companyObjective,
  analytics_goal: collectingDataEnterprise.analyticsGoal,
  business_summary: collectingDataEnterprise.businessSummary,
  main_products_or_services: collectingDataEnterprise.mainProductsOrServices,
  uses_company_products: collectingDataEnterprise.usesCompanyProducts,
  uses_company_services: collectingDataEnterprise.usesCompanyServices,
  uses_company_departments: collectingDataEnterprise.usesCompanyDepartments,
  created_at: collectingDataEnterprise.createdAt,
  updated_at: collectingDataEnterprise.updatedAt,
};

export async function getCollectingDataByEnterprise(
  enterpriseId: string,
): Promise<CollectingRow | null> {
  const rows = await getDb()
    .select(collectingColumns)
    .from(collectingDataEnterprise)
    .where(eq(collectingDataEnterprise.enterpriseId, enterpriseId))
    .limit(1);
  return rows[0] ?? null;
}

// ----------------------------------------------------------------------------
// Snapshots do catálogo e das perguntas COMPANY (para a resposta do editor)
// ----------------------------------------------------------------------------

export interface CatalogSnapshotRow {
  id: string;
  enterprise_id: string;
  kind: string;
  name: string;
  description: string | null;
  status: string;
  sort_order: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface CatalogSnapshot {
  catalog_products: CatalogSnapshotRow[];
  catalog_services: CatalogSnapshotRow[];
  catalog_departments: CatalogSnapshotRow[];
}

export async function getCatalogSnapshot(enterpriseId: string): Promise<CatalogSnapshot> {
  const rows = await getDb()
    .select({
      id: catalogItems.id,
      enterprise_id: catalogItems.enterpriseId,
      kind: catalogItems.kind,
      name: catalogItems.name,
      description: catalogItems.description,
      status: catalogItems.status,
      sort_order: catalogItems.sortOrder,
      created_at: catalogItems.createdAt,
      updated_at: catalogItems.updatedAt,
    })
    .from(catalogItems)
    .where(and(eq(catalogItems.enterpriseId, enterpriseId), eq(catalogItems.status, 'ACTIVE')))
    .orderBy(asc(catalogItems.sortOrder), asc(catalogItems.createdAt));

  return {
    catalog_products: rows.filter((item) => item.kind === 'PRODUCT'),
    catalog_services: rows.filter((item) => item.kind === 'SERVICE'),
    catalog_departments: rows.filter((item) => item.kind === 'DEPARTMENT'),
  };
}

export interface CompanySubquestionSnapshot {
  id: string;
  question_id: string;
  subquestion_order: number;
  subquestion_text: string;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface CompanyQuestionSnapshot {
  id: string;
  enterprise_id: string;
  scope_type: string;
  catalog_item_id: string | null;
  question_order: number;
  question_text: string;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
  subquestions: CompanySubquestionSnapshot[];
}

/**
 * Snapshot das 3 perguntas COMPANY (catalog_item_id IS NULL) do editor — inclui
 * perguntas/subperguntas INATIVAS (o editor as mostra como desativadas). Dedup
 * por question_order pegando a primeira (order asc, updated_at desc, created_at desc).
 */
export async function getCompanyQuestionsSnapshot(
  enterpriseId: string,
): Promise<CompanyQuestionSnapshot[]> {
  const questionRows = await getDb()
    .select({
      id: questionsOfFeedbacks.id,
      enterprise_id: questionsOfFeedbacks.enterpriseId,
      scope_type: questionsOfFeedbacks.scopeType,
      catalog_item_id: questionsOfFeedbacks.catalogItemId,
      question_order: questionsOfFeedbacks.questionOrder,
      question_text: questionsOfFeedbacks.questionText,
      is_active: questionsOfFeedbacks.isActive,
      created_at: questionsOfFeedbacks.createdAt,
      updated_at: questionsOfFeedbacks.updatedAt,
    })
    .from(questionsOfFeedbacks)
    .where(
      and(
        eq(questionsOfFeedbacks.enterpriseId, enterpriseId),
        eq(questionsOfFeedbacks.scopeType, 'COMPANY'),
        isNull(questionsOfFeedbacks.catalogItemId),
      ),
    )
    .orderBy(
      asc(questionsOfFeedbacks.questionOrder),
      desc(questionsOfFeedbacks.updatedAt),
      desc(questionsOfFeedbacks.createdAt),
    );

  const questionIds = questionRows.map((row) => row.id);
  const subquestionsByQuestionId = new Map<string, CompanySubquestionSnapshot[]>();

  if (questionIds.length > 0) {
    const subRows = await getDb()
      .select({
        id: feedbackQuestionSubquestions.id,
        question_id: feedbackQuestionSubquestions.questionId,
        subquestion_order: feedbackQuestionSubquestions.subquestionOrder,
        subquestion_text: feedbackQuestionSubquestions.subquestionText,
        is_active: feedbackQuestionSubquestions.isActive,
        created_at: feedbackQuestionSubquestions.createdAt,
        updated_at: feedbackQuestionSubquestions.updatedAt,
      })
      .from(feedbackQuestionSubquestions)
      .where(inArray(feedbackQuestionSubquestions.questionId, questionIds))
      .orderBy(asc(feedbackQuestionSubquestions.subquestionOrder));

    for (const row of subRows) {
      const current = subquestionsByQuestionId.get(row.question_id) ?? [];
      current.push(row);
      subquestionsByQuestionId.set(row.question_id, current);
    }
  }

  const firstByOrder = new Map<number, CompanyQuestionSnapshot>();
  for (const row of questionRows) {
    if (firstByOrder.has(row.question_order)) continue;
    firstByOrder.set(row.question_order, {
      ...row,
      subquestions: (subquestionsByQuestionId.get(row.id) ?? []).sort(
        (a, b) => a.subquestion_order - b.subquestion_order,
      ),
    });
  }

  return Array.from(firstByOrder.values()).sort((a, b) => a.question_order - b.question_order);
}

// ----------------------------------------------------------------------------
// Escrita transacional: collecting_data + syncs (catálogo e perguntas COMPANY)
// ----------------------------------------------------------------------------

export interface NormalizedCatalogItem {
  id?: string;
  name: string;
  description: string | null;
  sortOrder: number;
  status: 'ACTIVE' | 'INACTIVE';
}

export interface NormalizedCompanySubquestion {
  subquestion_order: 1 | 2 | 3;
  subquestion_text: string;
  is_active: boolean;
}

export interface NormalizedCompanyQuestion {
  question_order: 1 | 2 | 3;
  question_text: string;
  is_active: boolean;
  subquestionsByOrder: Map<1 | 2 | 3, NormalizedCompanySubquestion>;
}

export interface CatalogSyncStep {
  kind: CatalogKind;
  items: NormalizedCatalogItem[];
  disableAll: boolean;
  run: boolean;
}

export interface SyncPlan {
  catalog: CatalogSyncStep[];
  questions: NormalizedCompanyQuestion[] | null; // null = não sincronizar perguntas
}

/** Colunas (camelCase) graváveis de collecting_data_enterprise. */
export interface CollectingWriteColumns {
  companyObjective?: string | null;
  analyticsGoal?: string | null;
  businessSummary?: string | null;
  mainProductsOrServices?: string[] | null;
  usesCompanyProducts?: boolean;
  usesCompanyServices?: boolean;
  usesCompanyDepartments?: boolean;
}

async function syncCatalogItemsTx(tx: Tx, enterpriseId: string, step: CatalogSyncStep): Promise<void> {
  const nowIso = new Date().toISOString();

  if (step.disableAll) {
    await tx
      .update(catalogItems)
      .set({ status: 'INACTIVE', updatedAt: nowIso })
      .where(
        and(
          eq(catalogItems.enterpriseId, enterpriseId),
          eq(catalogItems.kind, step.kind),
          eq(catalogItems.status, 'ACTIVE'),
        ),
      );
    return;
  }

  const existing = await tx
    .select({ id: catalogItems.id })
    .from(catalogItems)
    .where(and(eq(catalogItems.enterpriseId, enterpriseId), eq(catalogItems.kind, step.kind)));
  const existingIds = new Set(existing.map((row) => row.id));

  const updateRows = step.items
    .filter((item) => item.id && existingIds.has(item.id))
    .map((item) => ({
      id: item.id!,
      enterpriseId,
      kind: step.kind,
      name: item.name,
      description: item.description,
      sortOrder: item.sortOrder,
      status: item.status,
      updatedAt: nowIso,
    }));

  const insertRows = step.items
    .filter((item) => !item.id || !existingIds.has(item.id))
    .map((item) => ({
      enterpriseId,
      kind: step.kind,
      name: item.name,
      description: item.description,
      sortOrder: item.sortOrder,
      status: item.status,
    }));

  if (updateRows.length > 0) {
    await tx
      .insert(catalogItems)
      .values(updateRows)
      .onConflictDoUpdate({
        target: catalogItems.id,
        set: {
          name: sql`excluded.name`,
          description: sql`excluded.description`,
          sortOrder: sql`excluded.sort_order`,
          status: sql`excluded.status`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  if (insertRows.length > 0) {
    await tx.insert(catalogItems).values(insertRows);
  }

  const incomingKnownIds = new Set(
    step.items
      .map((item) => item.id)
      .filter((id): id is string => typeof id === 'string' && existingIds.has(id)),
  );
  const staleIds = [...existingIds].filter((id) => !incomingKnownIds.has(id));

  if (staleIds.length > 0) {
    await tx
      .update(catalogItems)
      .set({ status: 'INACTIVE', updatedAt: nowIso })
      .where(inArray(catalogItems.id, staleIds));
  }
}

async function syncCompanyQuestionsTx(
  tx: Tx,
  enterpriseId: string,
  questions: NormalizedCompanyQuestion[],
): Promise<void> {
  const nowIso = new Date().toISOString();

  for (const item of questions) {
    const updated = await tx
      .update(questionsOfFeedbacks)
      .set({ questionText: item.question_text, isActive: item.is_active, updatedAt: nowIso })
      .where(
        and(
          eq(questionsOfFeedbacks.enterpriseId, enterpriseId),
          eq(questionsOfFeedbacks.scopeType, 'COMPANY'),
          isNull(questionsOfFeedbacks.catalogItemId),
          eq(questionsOfFeedbacks.questionOrder, item.question_order),
        ),
      )
      .returning({ id: questionsOfFeedbacks.id });

    let questionId = updated[0]?.id;

    if (!questionId) {
      const inserted = await tx
        .insert(questionsOfFeedbacks)
        .values({
          enterpriseId,
          scopeType: 'COMPANY',
          catalogItemId: null,
          questionOrder: item.question_order,
          questionText: item.question_text,
          isActive: item.is_active,
        })
        .returning({ id: questionsOfFeedbacks.id });
      questionId = inserted[0]?.id;
      if (!questionId) throw new CollectingWriteError();
    }

    for (const subquestionOrder of [1, 2, 3] as const) {
      const subquestion = item.subquestionsByOrder.get(subquestionOrder);

      if (!subquestion) {
        // Soft-delete: desativa (preserva histórico ON DELETE CASCADE e o texto,
        // que tem CHECK de 20–150 chars).
        await tx
          .update(feedbackQuestionSubquestions)
          .set({ isActive: false, updatedAt: nowIso })
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
        .set({
          subquestionText: subquestion.subquestion_text,
          isActive: subquestion.is_active,
          updatedAt: nowIso,
        })
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
        isActive: subquestion.is_active,
      });
    }
  }
}

async function runSyncPlanTx(tx: Tx, enterpriseId: string, plan: SyncPlan): Promise<void> {
  for (const step of plan.catalog) {
    if (step.run) await syncCatalogItemsTx(tx, enterpriseId, step);
  }
  if (plan.questions) {
    await syncCompanyQuestionsTx(tx, enterpriseId, plan.questions);
  }
}

function mapCollectingRow(row: Record<string, unknown>): CollectingRow {
  return {
    id: row.id as string,
    enterprise_id: row.enterprise_id as string,
    company_objective: (row.company_objective as string | null) ?? null,
    analytics_goal: (row.analytics_goal as string | null) ?? null,
    business_summary: (row.business_summary as string | null) ?? null,
    main_products_or_services: (row.main_products_or_services as string[] | null) ?? null,
    uses_company_products: Boolean(row.uses_company_products),
    uses_company_services: Boolean(row.uses_company_services),
    uses_company_departments: Boolean(row.uses_company_departments),
    created_at: (row.created_at as string | null) ?? null,
    updated_at: (row.updated_at as string | null) ?? null,
  };
}

/**
 * PATCH: atualiza collecting_data pelas chaves presentes (ou insere se ainda não
 * existir) e roda os syncs — TUDO numa transação (atômico; o Supabase não era).
 */
export async function saveCollectingDataPatch(params: {
  enterpriseId: string;
  update: CollectingWriteColumns;
  insert: CollectingWriteColumns;
  plan: SyncPlan;
}): Promise<CollectingRow> {
  const { enterpriseId, update, insert, plan } = params;

  try {
    return await getDb().transaction(async (tx) => {
      const updated = await tx
        .update(collectingDataEnterprise)
        .set({ ...update, updatedAt: new Date().toISOString() })
        .where(eq(collectingDataEnterprise.enterpriseId, enterpriseId))
        .returning(collectingColumns);

      let row = updated[0];

      if (!row) {
        const inserted = await tx
          .insert(collectingDataEnterprise)
          .values({ enterpriseId, ...insert })
          .returning(collectingColumns);
        row = inserted[0];
        if (!row) throw new CollectingWriteError();
      }

      await runSyncPlanTx(tx, enterpriseId, plan);
      return mapCollectingRow(row);
    });
  } catch (err) {
    if (err instanceof CollectingWriteError) throw err;
    // Só violação de integridade (dado inválido) vira 400; infra propaga → 500.
    if (isIntegrityViolation(err)) throw new CollectingWriteError();
    throw err;
  }
}

/**
 * UPSERT: grava o objeto completo de collecting_data (onConflict enterprise_id) e
 * roda todos os syncs — numa transação.
 */
export async function saveCollectingDataUpsert(params: {
  enterpriseId: string;
  values: CollectingWriteColumns;
  plan: SyncPlan;
}): Promise<CollectingRow> {
  const { enterpriseId, values, plan } = params;

  try {
    return await getDb().transaction(async (tx) => {
      const nowIso = new Date().toISOString();
      const upserted = await tx
        .insert(collectingDataEnterprise)
        .values({ enterpriseId, ...values, updatedAt: nowIso })
        .onConflictDoUpdate({
          target: collectingDataEnterprise.enterpriseId,
          set: { ...values, updatedAt: nowIso },
        })
        .returning(collectingColumns);

      const row = upserted[0];
      if (!row) throw new CollectingWriteError();

      await runSyncPlanTx(tx, enterpriseId, plan);
      return mapCollectingRow(row);
    });
  } catch (err) {
    if (err instanceof CollectingWriteError) throw err;
    // Só violação de integridade (dado inválido) vira 400; infra propaga → 500.
    if (isIntegrityViolation(err)) throw new CollectingWriteError();
    throw err;
  }
}
