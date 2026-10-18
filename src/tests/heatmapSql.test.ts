import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { heatmapCellExpressions } from '../repositories/feedbackHeatmap.repository.js';

// Compila as expressões sem tocar no banco: dia da semana e faixa de 6 horas
// no fuso do gestor, com o fuso sempre como parâmetro (nunca concatenado).
const dialect = new PgDialect();

describe('[Unit] dias e horários de pico — SQL das células', () => {
  it('dia da semana e faixa do dia no fuso pedido', () => {
    const { weekday, band } = heatmapCellExpressions('America/Sao_Paulo');
    const day = dialect.sqlToQuery(weekday);
    expect(day.sql).toMatch(/extract\(dow from \("feedback"\."created_at" AT TIME ZONE \$1\)\)::int/);
    expect(day.params).toEqual(['America/Sao_Paulo']);

    const slot = dialect.sqlToQuery(band);
    expect(slot.sql).toMatch(/floor\(extract\(hour from \("feedback"\."created_at" AT TIME ZONE \$1\)\) \/ 6\)::int/);
    expect(slot.params).toEqual(['America/Sao_Paulo']);
  });
});
