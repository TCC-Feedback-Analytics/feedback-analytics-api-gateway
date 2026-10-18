import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { timelineStartExpression } from '../repositories/feedbackTimeline.repository.js';

// Compila a expressão de agrupamento sem tocar no banco: o intervalo entra como
// literal da lista fechada e o fuso vai como parâmetro (nunca concatenado).
const dialect = new PgDialect();

describe('[Unit] movimento no tempo — SQL do agrupamento', () => {
  it('agrupa por date_trunc no fuso do gestor, com o fuso como parâmetro', () => {
    const { sql, params } = dialect.sqlToQuery(timelineStartExpression('week', 'America/Sao_Paulo'));
    expect(sql).toMatch(/date_trunc\('week', "feedback"\."created_at" AT TIME ZONE \$1\)/);
    expect(sql).toMatch(/^to_char\(.*'YYYY-MM-DD'\)$/);
    expect(params).toEqual(['America/Sao_Paulo']);
  });
});
