/**
 * Período das métricas (etapa 02). A Web resolve "últimos 30 dias" etc. no fuso
 * do gestor e envia instantes ISO absolutos; aqui só validamos e normalizamos.
 * Intervalo meio aberto: `start` incluído, `end` excluído. Sem os dois, vale o
 * histórico inteiro (comportamento anterior).
 */
export interface MetricsPeriod {
  start: string | null;
  end: string | null;
}

export type ParsedMetricsPeriod = { period: MetricsPeriod } | { error: 'invalid_period' };

/** Aceita só datas ISO 8601 (com hora ou só a data); devolve em UTC ou null se inválida. */
function parseInstant(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim();
  if (!value) return undefined;
  if (value.length > 40 || !/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export function parseMetricsPeriod(query: { start_date?: unknown; end_date?: unknown }): ParsedMetricsPeriod {
  const start = parseInstant(query.start_date);
  const end = parseInstant(query.end_date);
  if (start === null || end === null) return { error: 'invalid_period' };
  if (start && end && start >= end) return { error: 'invalid_period' };
  return { period: { start: start ?? null, end: end ?? null } };
}

export function hasPeriod(period: MetricsPeriod | null | undefined): period is MetricsPeriod {
  return Boolean(period && (period.start || period.end));
}
