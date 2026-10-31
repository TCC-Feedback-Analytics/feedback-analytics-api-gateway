import { describe, it, expect } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../../drizzle/schema.js';
import { customerVisitsQueries } from '../repositories/feedbackCustomers.repository.js';
import { summarizeCustomers } from '../libs/customers.js';

// Monta as consultas sem banco (drizzle.mock): prova que a numeração por
// aparelho é feita na empresa inteira e que escopo e período recortam depois.
const db = drizzle.mock({ schema });

describe('[Unit] clientes que voltam — SQL', () => {
  it('numera as visitas por aparelho dentro da empresa e recorta escopo e período fora da subconsulta', () => {
    const { byVisit, devices } = customerVisitsQueries(db, {
      enterpriseId: 'ent-A',
      collectionPointIds: ['cp-1'],
      period: { start: '2026-09-18T03:00:00.000Z', end: '2026-10-19T03:00:00.000Z' },
    });

    const visits = byVisit.toSQL();
    expect(visits.sql).toMatch(/row_number\(\) over \(partition by "tracked_device_id" order by "created_at", "id"\) as "seq"/);
    // O filtro de empresa (e a saída dos testes do dono) fica dentro da subconsulta; o escopo e o período, fora.
    expect(visits.sql).toMatch(/from "feedback" where \("feedback"\."enterprise_id" = \$1 and "feedback"\."channel" IS DISTINCT FROM 'TEST'\)\) "visits" where/);
    expect(visits.sql).toMatch(/"visits"\."collection_point_id" in \(\$2\)/);
    expect(visits.sql).toMatch(/case when "tracked_device_id" is null then 'unidentified' when "seq" > 1 then 'returning' else 'first' end/);
    expect(visits.sql).toMatch(/group by 1, 2$/);
    expect(visits.params).toEqual(['ent-A', 'cp-1', '2026-09-18T03:00:00.000Z', '2026-10-19T03:00:00.000Z']);

    expect(devices.toSQL().sql).toMatch(/count\(distinct "tracked_device_id"\) filter \(where "seq" > 1\)/);
  });

  it('recusa empresa vazia', () => {
    expect(() => customerVisitsQueries(db, { enterpriseId: '', collectionPointIds: null })).toThrow();
  });
});

describe('[Unit] clientes que voltam — resumo', () => {
  it('percentual de quem volta e a média de cada grupo, sem contar os não identificados', () => {
    const summary = summarizeCustomers(
      [
        { visit: 'first', rating: 4, count: 30 },
        { visit: 'first', rating: 3, count: 10 },
        { visit: 'returning', rating: 5, count: 8 },
        { visit: 'returning', rating: 4, count: 2 },
        { visit: 'unidentified', rating: 1, count: 5 },
      ],
      { customers: 42, returningCustomers: 6 },
    );

    expect(summary.identified).toBe(50);
    expect(summary.unidentified).toBe(5);
    expect(summary.returningCount).toBe(10);
    expect(summary.returningPct).toBe(20);
    expect(summary.returningPctCI!.lower).toBeLessThan(20);
    expect(summary.returning).toMatchObject({ n: 10, mean: 4.8 });
    expect(summary.firstTime).toMatchObject({ n: 40, mean: 3.75 });
    expect(summary.customers).toBe(42);
    expect(summary.returningCustomers).toBe(6);
  });

  it('sem avaliações identificadas, percentuais e médias vêm nulos', () => {
    const summary = summarizeCustomers([{ visit: 'unidentified', rating: 5, count: 3 }], { customers: 0, returningCustomers: 0 });
    expect(summary.returningPct).toBeNull();
    expect(summary.returning).toBeNull();
    expect(summary.firstTime).toBeNull();
  });
});
