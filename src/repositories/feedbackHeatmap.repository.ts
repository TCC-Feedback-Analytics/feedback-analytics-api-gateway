import { count, sql, sum } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { feedback } from '../../drizzle/schema.js';
import { scopedFeedbackWhere } from '../db/tenantScope.js';
import type { MetricsPeriod } from '../libs/period.js';
import { BAND_HOURS, type HeatmapRow } from '../libs/heatmap.js';

export interface ScopedHeatmapParams {
  enterpriseId: string;
  /** `null` = toda a empresa; `[]` = escopo sem pontos (zero resultados). */
  collectionPointIds: string[] | null;
  period?: MetricsPeriod | null;
  /** Fuso IANA já validado (`parseTimezone`). */
  timeZone: string;
}

/** Dia da semana (0 domingo … 6 sábado) e faixa do dia (0 a 3), no fuso do gestor. */
export function heatmapCellExpressions(timeZone: string) {
  const local = sql`(${feedback.createdAt} AT TIME ZONE ${timeZone})`;
  return {
    weekday: sql<number>`extract(dow from ${local})::int`,
    band: sql<number>`floor(extract(hour from ${local}) / ${sql.raw(String(BAND_HOURS))})::int`,
  };
}

/**
 * Avaliações por dia da semana × faixa do dia, agrupadas NO BANCO. Sempre por
 * `enterprise_id` (+ escopo e período) pelo helper único. Só devolve as células
 * com avaliação; o preenchimento das vazias fica em `fillHeatmap`.
 */
export async function fetchScopedHeatmap(params: ScopedHeatmapParams): Promise<HeatmapRow[]> {
  const { enterpriseId, collectionPointIds, period, timeZone } = params;
  if (Array.isArray(collectionPointIds) && collectionPointIds.length === 0) return [];

  const { weekday, band } = heatmapCellExpressions(timeZone);
  // GROUP BY pela posição: as expressões têm parâmetro e não se repetem iguais.
  const rows = await getDb()
    .select({
      weekday,
      band,
      c: count(),
      ratingCount: count(feedback.rating),
      ratingSum: sum(feedback.rating),
    })
    .from(feedback)
    .where(scopedFeedbackWhere(enterpriseId, collectionPointIds, period))
    .groupBy(sql`1, 2`);

  return rows.map((row) => ({
    weekday: Number(row.weekday),
    band: Number(row.band),
    count: Number(row.c),
    ratingCount: Number(row.ratingCount),
    ratingSum: Number(row.ratingSum ?? 0),
  }));
}
