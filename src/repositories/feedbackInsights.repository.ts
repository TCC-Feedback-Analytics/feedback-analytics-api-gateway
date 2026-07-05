import { desc, eq, isNull, type SQL } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { feedbackInsightsReport } from '../../drizzle/schema.js';
import { scopedByEnterprise } from '../db/tenantScope.js';

export interface ScopedInsightsReport {
  summary: string | null;
  recommendations: string[] | null;
  updatedAt: string | null;
  scopeType: string | null;
  catalogItemId: string | null;
}

/**
 * Relatório de insights (IA) do escopo, SEMPRE filtrado por `enterprise_id`
 * (isolamento na aplicação — o Drizzle ignora a RLS). Filtra por `scope_type` e,
 * dentro dele, pelo `catalog_item_id` (igual quando informado; `IS NULL` no escopo
 * COMPANY). Retorna o mais recente (`updated_at DESC`) ou `null`.
 */
export async function fetchScopedInsightsReport(params: {
  enterpriseId: string;
  scopeType: string;
  catalogItemId: string | null;
}): Promise<ScopedInsightsReport | null> {
  const { enterpriseId, scopeType, catalogItemId } = params;

  const catalogCond: SQL | undefined = catalogItemId
    ? eq(feedbackInsightsReport.catalogItemId, catalogItemId)
    : scopeType === 'COMPANY'
      ? isNull(feedbackInsightsReport.catalogItemId)
      : undefined;

  const rows = await getDb()
    .select({
      summary: feedbackInsightsReport.summary,
      recommendations: feedbackInsightsReport.recommendations,
      updatedAt: feedbackInsightsReport.updatedAt,
      scopeType: feedbackInsightsReport.scopeType,
      catalogItemId: feedbackInsightsReport.catalogItemId,
    })
    .from(feedbackInsightsReport)
    .where(
      scopedByEnterprise(
        feedbackInsightsReport.enterpriseId,
        enterpriseId,
        eq(feedbackInsightsReport.scopeType, scopeType),
        catalogCond,
      ),
    )
    .orderBy(desc(feedbackInsightsReport.updatedAt))
    .limit(1);

  return rows[0] ?? null;
}
