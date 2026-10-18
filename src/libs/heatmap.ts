/**
 * Dias e horários de pico (métricas novas, 3): quantas avaliações chegam e a
 * média em cada dia da semana × faixa do dia, no fuso do gestor. Faixas de 6
 * horas em vez de hora a hora: com pouco volume, a grade de 24 horas fica vazia.
 */

/** 0 madrugada (0–6h) · 1 manhã (6–12h) · 2 tarde (12–18h) · 3 noite (18–24h). */
export const DAY_BANDS = 4;
export const BAND_HOURS = 24 / DAY_BANDS;

/** Dia da semana como o `extract(dow)` do Postgres: 0 domingo … 6 sábado. */
export const WEEKDAYS = 7;

export interface HeatmapRow {
  weekday: number;
  band: number;
  count: number;
  ratingCount: number;
  ratingSum: number;
}

export interface HeatmapCell {
  weekday: number;
  band: number;
  count: number;
  /** Média das notas na faixa; `null` sem avaliações. */
  mean: number | null;
}

/** As 28 células (7 dias × 4 faixas), em ordem, com zero onde não houve avaliação. */
export function fillHeatmap(rows: HeatmapRow[]): HeatmapCell[] {
  const byCell = new Map(rows.map((row) => [`${row.weekday}:${row.band}`, row]));
  const cells: HeatmapCell[] = [];
  for (let weekday = 0; weekday < WEEKDAYS; weekday++) {
    for (let band = 0; band < DAY_BANDS; band++) {
      const row = byCell.get(`${weekday}:${band}`);
      cells.push({
        weekday,
        band,
        count: row?.count ?? 0,
        mean: row && row.ratingCount > 0 ? Math.round((row.ratingSum / row.ratingCount) * 100) / 100 : null,
      });
    }
  }
  return cells;
}
