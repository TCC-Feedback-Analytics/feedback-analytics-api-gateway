import { and, count, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { getDb } from '../db/client.js';
import { assertEnterpriseId } from '../db/tenantScope.js';
import * as schema from '../../drizzle/schema.js';
import { feedback } from '../../drizzle/schema.js';
import type { MetricsPeriod } from '../libs/period.js';
import type { CustomerVisit, CustomerVisitRow } from '../libs/customers.js';

export interface ScopedCustomersParams {
  enterpriseId: string;
  /** `null` = toda a empresa; `[]` = escopo sem pontos (zero resultados). */
  collectionPointIds: string[] | null;
  period?: MetricsPeriod | null;
}

/**
 * As duas consultas dos clientes que voltam, montadas sem executar (testáveis com
 * `drizzle.mock()`). A subconsulta numera as avaliações de cada aparelho em toda
 * a EMPRESA (`row_number()`), para saber se ele já tinha avaliado antes, em
 * qualquer escopo; o escopo e o período recortam só depois. O filtro por
 * `enterprise_id` fica dentro da subconsulta (isolamento multi-tenant).
 */
export function customerVisitsQueries(db: PostgresJsDatabase<typeof schema>, params: ScopedCustomersParams) {
  const { enterpriseId, collectionPointIds, period } = params;
  assertEnterpriseId(enterpriseId);

  const visits = db
    .select({
      collectionPointId: feedback.collectionPointId,
      createdAt: feedback.createdAt,
      rating: feedback.rating,
      device: feedback.trackedDeviceId,
      seq: sql<number>`row_number() over (partition by ${feedback.trackedDeviceId} order by ${feedback.createdAt}, ${feedback.id})`.as('seq'),
    })
    .from(feedback)
    .where(eq(feedback.enterpriseId, enterpriseId))
    .as('visits');

  const conds: SQL[] = [];
  if (collectionPointIds) conds.push(inArray(visits.collectionPointId, collectionPointIds));
  if (period?.start) conds.push(gte(visits.createdAt, period.start));
  if (period?.end) conds.push(lt(visits.createdAt, period.end));
  const where = conds.length > 0 ? and(...conds) : undefined;

  const visit = sql<CustomerVisit>`case when ${visits.device} is null then 'unidentified' when ${visits.seq} > 1 then 'returning' else 'first' end`;

  // GROUP BY pela posição: a expressão do CASE não se repete igual.
  const byVisit = db
    .select({ visit, rating: visits.rating, c: count() })
    .from(visits)
    .where(where)
    .groupBy(sql`1, 2`);

  const devices = db
    .select({
      customers: sql<number>`count(distinct ${visits.device})`,
      returningCustomers: sql<number>`count(distinct ${visits.device}) filter (where ${visits.seq} > 1)`,
    })
    .from(visits)
    .where(where);

  return { byVisit, devices };
}

/** Avaliações por tipo de visita × nota, e os aparelhos distintos, no escopo e no período. */
export async function fetchScopedCustomerVisits(
  params: ScopedCustomersParams,
): Promise<{ rows: CustomerVisitRow[]; customers: number; returningCustomers: number }> {
  if (Array.isArray(params.collectionPointIds) && params.collectionPointIds.length === 0) {
    return { rows: [], customers: 0, returningCustomers: 0 };
  }

  const { byVisit, devices } = customerVisitsQueries(getDb(), params);
  const [visitRows, deviceRows] = await Promise.all([byVisit, devices]);

  return {
    rows: visitRows.map((row) => ({
      visit: row.visit,
      rating: row.rating == null ? null : Number(row.rating),
      count: Number(row.c),
    })),
    customers: Number(deviceRows[0]?.customers ?? 0),
    returningCustomers: Number(deviceRows[0]?.returningCustomers ?? 0),
  };
}
