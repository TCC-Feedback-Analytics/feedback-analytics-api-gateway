import { pctInterval, ratingStats, type Interval } from './statistics/index.js';

/**
 * Clientes que voltam (métricas novas, 4). "Cliente" é o aparelho identificado
 * pelo anti-spam (`tracked_device_id`), então o número é aproximado. Uma
 * avaliação é "de quem volta" quando o mesmo aparelho já tinha avaliado a
 * EMPRESA antes, em qualquer escopo. Avaliações sem aparelho ficam de fora.
 */

export type CustomerVisit = 'first' | 'returning' | 'unidentified';

export interface CustomerVisitRow {
  visit: CustomerVisit;
  rating: number | null;
  count: number;
}

export interface CustomerGroupStats {
  n: number;
  mean: number;
  ci: Interval;
}

export interface CustomersSummary {
  /** Avaliações com aparelho identificado (base dos percentuais). */
  identified: number;
  unidentified: number;
  firstTimeCount: number;
  returningCount: number;
  /** % das avaliações identificadas que vieram de quem já tinha avaliado, com IC de Wilson. */
  returningPct: number | null;
  returningPctCI: Interval | null;
  /** Aparelhos distintos que avaliaram no escopo e no período. */
  customers: number;
  /** Desses, quantos avaliaram de novo no escopo e no período. */
  returningCustomers: number;
  firstTime: CustomerGroupStats | null;
  returning: CustomerGroupStats | null;
}

function groupStats(rows: CustomerVisitRow[], visit: CustomerVisit): CustomerGroupStats | null {
  const counts: Record<number, number> = {};
  for (const row of rows) {
    if (row.visit !== visit || row.rating == null) continue;
    counts[row.rating] = (counts[row.rating] ?? 0) + row.count;
  }
  const stats = ratingStats(counts);
  return stats.n > 0 ? { n: stats.n, mean: stats.mean, ci: stats.ci } : null;
}

export function summarizeCustomers(
  rows: CustomerVisitRow[],
  devices: { customers: number; returningCustomers: number },
): CustomersSummary {
  const total = (visit: CustomerVisit) =>
    rows.filter((row) => row.visit === visit).reduce((sum, row) => sum + row.count, 0);
  const firstTimeCount = total('first');
  const returningCount = total('returning');
  const identified = firstTimeCount + returningCount;

  return {
    identified,
    unidentified: total('unidentified'),
    firstTimeCount,
    returningCount,
    returningPct: identified > 0 ? Math.round((returningCount / identified) * 1000) / 10 : null,
    returningPctCI: identified > 0 ? pctInterval(returningCount, identified) : null,
    customers: devices.customers,
    returningCustomers: devices.returningCustomers,
    firstTime: groupStats(rows, 'first'),
    returning: groupStats(rows, 'returning'),
  };
}
