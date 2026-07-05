import { describe, it, expect, afterAll } from 'vitest';
import { fetchScopedInsightsReport } from '../../repositories/feedbackInsights.repository.js';
import { closeDb } from '../../db/client.js';

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000001';
const GHOST = '00000000-0000-0000-0000-000000000000';

afterAll(async () => {
  await closeDb();
});

describe('[Integração] fetchScopedInsightsReport — escopo + isolamento por tenant', () => {
  it('empresa A (COMPANY) retorna o relatório de A', async () => {
    const r = await fetchScopedInsightsReport({ enterpriseId: A, scopeType: 'COMPANY', catalogItemId: null });
    expect(r).not.toBeNull();
    expect(r?.summary).toContain('atendimento');
    expect(r?.recommendations).toEqual([
      'Reduzir o tempo de espera',
      'Manter a qualidade do atendimento',
    ]);
    expect(r?.scopeType).toBe('COMPANY');
  });

  it('empresa B (COMPANY) retorna o relatório de B — nunca o de A', async () => {
    const r = await fetchScopedInsightsReport({ enterpriseId: B, scopeType: 'COMPANY', catalogItemId: null });
    expect(r?.summary).toContain('corte');
    expect(r?.recommendations).toEqual(['Revisar o acabamento final']);
    expect(r?.summary).not.toContain('atendimento'); // não vaza o de A
  });

  it('escopo sem relatório (PRODUCT) => null', async () => {
    const r = await fetchScopedInsightsReport({ enterpriseId: A, scopeType: 'PRODUCT', catalogItemId: null });
    expect(r).toBeNull();
  });

  it('empresa inexistente => null (não vaza)', async () => {
    const r = await fetchScopedInsightsReport({ enterpriseId: GHOST, scopeType: 'COMPANY', catalogItemId: null });
    expect(r).toBeNull();
  });
});
