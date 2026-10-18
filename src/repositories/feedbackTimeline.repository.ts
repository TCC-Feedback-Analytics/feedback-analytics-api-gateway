import { count, sql, sum } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { feedback } from '../../drizzle/schema.js';
import { scopedFeedbackWhere } from '../db/tenantScope.js';
import type { MetricsPeriod } from '../libs/period.js';
import type { TimelineBucket, TimelineRow } from '../libs/timeline.js';

export interface ScopedTimelineParams {
  enterpriseId: string;
  /** `null` = toda a empresa; `[]` = escopo sem pontos (zero resultados). */
  collectionPointIds: string[] | null;
  period?: MetricsPeriod | null;
  bucket: TimelineBucket;
  /** Fuso IANA já validado (`parseTimezone`). */
  timeZone: string;
}

/**
 * Início do intervalo de cada avaliação, no fuso do gestor, como `AAAA-MM-DD`.
 * `bucket` vem de uma lista fechada (TIMELINE_BUCKETS) e entra no SQL como
 * literal; o fuso vai como parâmetro.
 */
export function timelineStartExpression(bucket: TimelineBucket, timeZone: string) {
  return sql<string>`to_char(date_trunc(${sql.raw(`'${bucket}'`)}, ${feedback.createdAt} AT TIME ZONE ${timeZone}), 'YYYY-MM-DD')`;
}

/**
 * Avaliações por dia, semana ou mês, agrupadas NO BANCO no fuso do gestor:
 * `date_trunc(bucket, created_at AT TIME ZONE tz)`. Sempre por `enterprise_id`
 * (+ escopo e período) pelo helper único. Só devolve os intervalos com
 * avaliação; o preenchimento dos vazios fica em `fillTimeline`.
 */
export async function fetchScopedTimeline(params: ScopedTimelineParams): Promise<TimelineRow[]> {
  const { enterpriseId, collectionPointIds, period, bucket, timeZone } = params;
  if (Array.isArray(collectionPointIds) && collectionPointIds.length === 0) return [];

  // GROUP BY/ORDER BY pela posição: a expressão tem parâmetro e não se repete igual.
  const start = timelineStartExpression(bucket, timeZone);

  const rows = await getDb()
    .select({
      start,
      c: count(),
      ratingCount: count(feedback.rating),
      ratingSum: sum(feedback.rating),
    })
    .from(feedback)
    .where(scopedFeedbackWhere(enterpriseId, collectionPointIds, period))
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  return rows.map((row) => ({
    start: String(row.start),
    count: Number(row.c),
    ratingCount: Number(row.ratingCount),
    ratingSum: Number(row.ratingSum ?? 0),
  }));
}
