import { and, asc, count, desc, eq, ilike, inArray, type SQL } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {
  catalogItems,
  collectionPoints,
  customer,
  feedback,
  feedbackQuestionAnswers,
  trackedDevices,
} from '../../drizzle/schema.js';
import {
  scopedByEnterprise,
  scopedCollectionPointWhere,
  scopedFeedbackWhere,
} from '../db/tenantScope.js';

export type CategoryFilter = 'COMPANY' | 'PRODUCT' | 'SERVICE' | 'DEPARTMENT' | null;

export interface FeedbackListFilter {
  rating: number | null;
  search: string;
  /** `null` = empresa toda; array não vazio = recorte por pontos (`[]` tratado antes). */
  collectionPointIds: string[] | null;
}

export interface CatalogItemRow {
  id: string;
  name: string;
  kind: string | null;
}

export interface FeedbackAnswerRow {
  feedback_id: string;
  question_id: string;
  question_text_snapshot: string;
  answer_value: string;
  answer_score: number;
  created_at: string | null;
}

/**
 * Resolve o filtro de categoria/item → ids de collection_point (tenant-scoped).
 * `null` = sem filtro; `[]` = filtro sem resultados; array = recorte.
 */
export async function resolveCategoryCollectionPointIds(params: {
  enterpriseId: string;
  category: CategoryFilter;
  item: string;
}): Promise<string[] | null> {
  const { enterpriseId, category, item } = params;
  if (!category && !item) return null;

  const db = getDb();

  if (category === 'COMPANY') {
    if (item) return [];
    const rows = await db
      .select({ id: collectionPoints.id })
      .from(collectionPoints)
      .where(scopedCollectionPointWhere(enterpriseId, { catalogItemId: null }));
    return rows.map((r) => r.id);
  }

  const catalogConds: SQL[] = [];
  if (category) catalogConds.push(eq(catalogItems.kind, category));
  if (item) catalogConds.push(ilike(catalogItems.name, `%${item}%`));

  const catalogRows = await db
    .select({ id: catalogItems.id })
    .from(catalogItems)
    .where(scopedByEnterprise(catalogItems.enterpriseId, enterpriseId, ...catalogConds));

  const catalogIds = catalogRows.map((r) => r.id);
  if (catalogIds.length === 0) return [];

  const cpRows = await db
    .select({ id: collectionPoints.id })
    .from(collectionPoints)
    .where(scopedCollectionPointWhere(enterpriseId, { catalogItemIds: catalogIds }));
  return cpRows.map((r) => r.id);
}

function buildListWhere(enterpriseId: string, filter: FeedbackListFilter): SQL {
  const conds: SQL[] = [scopedFeedbackWhere(enterpriseId, filter.collectionPointIds)];
  if (filter.rating != null) conds.push(eq(feedback.rating, filter.rating));
  if (filter.search) conds.push(ilike(feedback.message, `%${filter.search}%`));
  return (conds.length === 1 ? conds[0] : and(...conds)) as SQL;
}

/** Conta feedbacks do escopo (mesmo WHERE da lista, sem o join). */
export async function countScopedFeedbacks(
  enterpriseId: string,
  filter: FeedbackListFilter,
): Promise<number> {
  const rows = await getDb()
    .select({ c: count() })
    .from(feedback)
    .where(buildListWhere(enterpriseId, filter));
  return Number(rows[0]?.c ?? 0);
}

/**
 * Página de feedbacks com o ponto de coleta (inner) e o dispositivo/cliente (left),
 * remontada no shape aninhado que o dashboard consome. SEMPRE tenant-scoped.
 */
export async function fetchScopedFeedbackPage(params: {
  enterpriseId: string;
  filter: FeedbackListFilter;
  limit: number;
  offset: number;
}): Promise<Array<Record<string, unknown>>> {
  const { enterpriseId, filter, limit, offset } = params;

  const rows = await getDb()
    .select({
      id: feedback.id,
      message: feedback.message,
      rating: feedback.rating,
      createdAt: feedback.createdAt,
      updatedAt: feedback.updatedAt,
      cpId: collectionPoints.id,
      cpName: collectionPoints.name,
      cpType: collectionPoints.type,
      cpIdentifier: collectionPoints.identifier,
      cpCatalogItemId: collectionPoints.catalogItemId,
      tdId: trackedDevices.id,
      tdFingerprint: trackedDevices.deviceFingerprint,
      tdUserAgent: trackedDevices.userAgent,
      tdIpAddress: trackedDevices.ipAddress,
      tdFeedbackCount: trackedDevices.feedbackCount,
      tdIsBlocked: trackedDevices.isBlocked,
      tdCustomerId: trackedDevices.customerId,
      custId: customer.id,
      custName: customer.name,
      custEmail: customer.email,
      custGender: customer.gender,
    })
    .from(feedback)
    .innerJoin(collectionPoints, eq(collectionPoints.id, feedback.collectionPointId))
    .leftJoin(trackedDevices, eq(trackedDevices.id, feedback.trackedDeviceId))
    .leftJoin(customer, eq(customer.id, trackedDevices.customerId))
    .where(buildListWhere(enterpriseId, filter))
    .orderBy(desc(feedback.createdAt))
    .limit(limit)
    .offset(offset);

  return rows.map((r) => ({
    id: r.id,
    message: r.message,
    rating: r.rating,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    collection_points: {
      id: r.cpId,
      name: r.cpName,
      type: r.cpType,
      identifier: r.cpIdentifier,
      catalog_item_id: r.cpCatalogItemId,
    },
    tracked_devices: r.tdId
      ? {
          id: r.tdId,
          device_fingerprint: r.tdFingerprint,
          user_agent: r.tdUserAgent,
          ip_address: r.tdIpAddress,
          feedback_count: r.tdFeedbackCount,
          is_blocked: r.tdIsBlocked,
          customer_id: r.tdCustomerId,
          customer: r.custId
            ? { id: r.custId, name: r.custName, email: r.custEmail, gender: r.custGender }
            : null,
        }
      : null,
  }));
}

/** Catálogo (id, name, kind) por ids — para o enriquecimento; tenant-scoped. */
export async function fetchCatalogItemsByIds(
  enterpriseId: string,
  ids: string[],
): Promise<CatalogItemRow[]> {
  if (ids.length === 0) return [];
  return getDb()
    .select({ id: catalogItems.id, name: catalogItems.name, kind: catalogItems.kind })
    .from(catalogItems)
    .where(scopedByEnterprise(catalogItems.enterpriseId, enterpriseId, inArray(catalogItems.id, ids)));
}

/** Respostas dinâmicas dos feedbacks (isolamento transitivo via feedbackIds escopados). */
export async function fetchAnswersForFeedbacks(feedbackIds: string[]): Promise<FeedbackAnswerRow[]> {
  if (feedbackIds.length === 0) return [];
  return getDb()
    .select({
      feedback_id: feedbackQuestionAnswers.feedbackId,
      question_id: feedbackQuestionAnswers.questionId,
      question_text_snapshot: feedbackQuestionAnswers.questionTextSnapshot,
      answer_value: feedbackQuestionAnswers.answerValue,
      answer_score: feedbackQuestionAnswers.answerScore,
      created_at: feedbackQuestionAnswers.createdAt,
    })
    .from(feedbackQuestionAnswers)
    .where(inArray(feedbackQuestionAnswers.feedbackId, feedbackIds))
    .orderBy(asc(feedbackQuestionAnswers.createdAt));
}
