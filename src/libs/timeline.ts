/**
 * Movimento no tempo (métricas novas, 1): quantas avaliações chegam e a média
 * em cada dia, semana ou mês, no fuso do gestor. O banco agrupa; aqui ficam a
 * validação dos parâmetros e o preenchimento dos intervalos sem avaliação, para
 * o gráfico não pular datas.
 */

export const TIMELINE_BUCKETS = ['day', 'week', 'month'] as const;
export type TimelineBucket = (typeof TIMELINE_BUCKETS)[number];

/** Teto de pontos por resposta: a Web escolhe semana ou mês para intervalos longos. */
export const TIMELINE_MAX_POINTS = 400;

export const DEFAULT_TIMELINE_TZ = 'America/Sao_Paulo';

export function parseTimelineBucket(raw: unknown): TimelineBucket | null {
  const value = String(raw ?? '').trim() || 'day';
  return (TIMELINE_BUCKETS as readonly string[]).includes(value) ? (value as TimelineBucket) : null;
}

/** Fuso IANA ("America/Sao_Paulo"); sem fuso, o padrão do produto. Inválido → null. */
export function parseTimezone(raw: unknown): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return DEFAULT_TIMELINE_TZ;
  if (value.length > 64 || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$|^UTC$/.test(value)) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

/** Data local (`AAAA-MM-DD`) de um instante, no fuso dado. */
export function localDateOf(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

// Aritmética de datas locais em UTC puro: só o calendário importa aqui.
function toUtc(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Início do intervalo que contém a data, como o `date_trunc` do Postgres (semana começa na segunda). */
export function bucketStart(date: string, bucket: TimelineBucket): string {
  const d = toUtc(date);
  if (bucket === 'month') return fromUtc(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)));
  if (bucket === 'week') {
    const daysSinceMonday = (d.getUTCDay() + 6) % 7;
    return fromUtc(new Date(d.getTime() - daysSinceMonday * 86_400_000));
  }
  return date;
}

function nextBucket(start: string, bucket: TimelineBucket): string {
  const d = toUtc(start);
  if (bucket === 'month') return fromUtc(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)));
  return fromUtc(new Date(d.getTime() + (bucket === 'week' ? 7 : 1) * 86_400_000));
}

export interface TimelineRow {
  /** Início do intervalo (`AAAA-MM-DD`), já no fuso pedido. */
  start: string;
  count: number;
  ratingCount: number;
  ratingSum: number;
}

export interface TimelinePoint {
  start: string;
  count: number;
  /** Média das notas do intervalo; `null` sem avaliações. */
  mean: number | null;
}

/**
 * Sequência contínua de intervalos entre `fromDate` e `toDate` (datas locais,
 * inclusive), com zero onde não houve avaliação. `null` se passar do teto.
 */
export function fillTimeline(
  rows: TimelineRow[],
  { fromDate, toDate, bucket }: { fromDate: string; toDate: string; bucket: TimelineBucket },
): TimelinePoint[] | null {
  const byStart = new Map(rows.map((row) => [row.start, row]));
  const last = bucketStart(toDate, bucket);
  const points: TimelinePoint[] = [];

  for (let start = bucketStart(fromDate, bucket); start <= last; start = nextBucket(start, bucket)) {
    if (points.length >= TIMELINE_MAX_POINTS) return null;
    const row = byStart.get(start);
    points.push({
      start,
      count: row?.count ?? 0,
      mean: row && row.ratingCount > 0 ? Math.round((row.ratingSum / row.ratingCount) * 100) / 100 : null,
    });
  }

  return points;
}
