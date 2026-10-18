import { describe, it, expect } from 'vitest';
import { parseMetricsPeriod, hasPeriod } from '../libs/period.js';

describe('[Unit] parseMetricsPeriod — período das métricas (etapa 02)', () => {
  it('sem datas vale o histórico inteiro', () => {
    expect(parseMetricsPeriod({})).toEqual({ period: { start: null, end: null } });
    expect(parseMetricsPeriod({ start_date: '', end_date: '  ' })).toEqual({ period: { start: null, end: null } });
    expect(hasPeriod({ start: null, end: null })).toBe(false);
  });

  it('normaliza instantes ISO para UTC', () => {
    const parsed = parseMetricsPeriod({
      start_date: '2026-09-17T00:00:00-03:00',
      end_date: '2026-10-17T03:00:00.000Z',
    });
    expect(parsed).toEqual({
      period: { start: '2026-09-17T03:00:00.000Z', end: '2026-10-17T03:00:00.000Z' },
    });
    if ('period' in parsed) expect(hasPeriod(parsed.period)).toBe(true);
  });

  it('aceita só um dos lados', () => {
    expect(parseMetricsPeriod({ start_date: '2026-10-01T00:00:00Z' })).toEqual({
      period: { start: '2026-10-01T00:00:00.000Z', end: null },
    });
  });

  it('recusa data fora do formato ISO ou inexistente', () => {
    expect(parseMetricsPeriod({ start_date: 'ontem' })).toEqual({ error: 'invalid_period' });
    expect(parseMetricsPeriod({ end_date: '17/10/2026' })).toEqual({ error: 'invalid_period' });
    expect(parseMetricsPeriod({ start_date: '2026-13-45' })).toEqual({ error: 'invalid_period' });
  });

  it('recusa início igual ou depois do fim', () => {
    expect(parseMetricsPeriod({ start_date: '2026-10-17T00:00:00Z', end_date: '2026-10-17T00:00:00Z' })).toEqual({
      error: 'invalid_period',
    });
    expect(parseMetricsPeriod({ start_date: '2026-10-18T00:00:00Z', end_date: '2026-10-17T00:00:00Z' })).toEqual({
      error: 'invalid_period',
    });
  });
});
