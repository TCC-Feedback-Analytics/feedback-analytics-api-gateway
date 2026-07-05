import { describe, it, expect, afterAll } from 'vitest';
import { resolveScopeCollectionPointIds } from '../../repositories/scope.repository.js';
import { closeDb } from '../../db/client.js';

// UUIDs fixos do seed (db/local/seed.sql).
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000001';
const A_POINT = 'cccccccc-0000-0000-0000-0000000000aa'; // QR Geral A (catalog_item_id NULL)
const B_POINT = 'cccccccc-0000-0000-0000-0000000000bb'; // QR Geral B

afterAll(async () => {
  await closeDb();
});

describe('[Integração] resolveScopeCollectionPointIds — escopo + isolamento por tenant', () => {
  it('sem escopo => { ids: null } (empresa inteira)', async () => {
    const r = await resolveScopeCollectionPointIds({
      enterpriseId: A,
      scopeType: undefined,
      catalogItemId: null,
    });
    expect(r).toEqual({ error: false, ids: null });
  });

  it('COMPANY => apenas o ponto geral da PRÓPRIA empresa', async () => {
    const a = await resolveScopeCollectionPointIds({ enterpriseId: A, scopeType: 'COMPANY', catalogItemId: null });
    expect(a).toEqual({ error: false, ids: [A_POINT] });

    const b = await resolveScopeCollectionPointIds({ enterpriseId: B, scopeType: 'COMPANY', catalogItemId: null });
    expect(b).toEqual({ error: false, ids: [B_POINT] });
  });

  it('ISOLAMENTO: A nunca resolve o ponto de B', async () => {
    const a = await resolveScopeCollectionPointIds({ enterpriseId: A, scopeType: 'COMPANY', catalogItemId: null });
    expect(a.error).toBe(false);
    if (!a.error) {
      expect(a.ids).toContain(A_POINT);
      expect(a.ids).not.toContain(B_POINT);
    }
  });

  it('PRODUCT sem catálogo no seed => [] (nenhum ponto)', async () => {
    const r = await resolveScopeCollectionPointIds({ enterpriseId: A, scopeType: 'PRODUCT', catalogItemId: null });
    expect(r).toEqual({ error: false, ids: [] });
  });

  it('catalog_item_id inexistente/de outra empresa => [] (não vaza)', async () => {
    const r = await resolveScopeCollectionPointIds({
      enterpriseId: A,
      scopeType: 'PRODUCT',
      catalogItemId: '11111111-2222-3333-4444-555555555555',
    });
    expect(r).toEqual({ error: false, ids: [] });
  });
});
