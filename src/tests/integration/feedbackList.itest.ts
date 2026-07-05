import { describe, it, expect, afterAll } from 'vitest';
import {
  resolveCategoryCollectionPointIds,
  countScopedFeedbacks,
  fetchScopedFeedbackPage,
} from '../../repositories/feedbackList.repository.js';
import { closeDb } from '../../db/client.js';

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000001';
const A_POINT = 'cccccccc-0000-0000-0000-0000000000aa';

const noFilter = { rating: null, search: '', collectionPointIds: null };

afterAll(async () => {
  await closeDb();
});

describe('[Integração] feedbackList — contagem, página e isolamento por tenant', () => {
  it('countScopedFeedbacks: A=5, B=2 (isolados)', async () => {
    expect(await countScopedFeedbacks(A, noFilter)).toBe(5);
    expect(await countScopedFeedbacks(B, noFilter)).toBe(2);
  });

  it('countScopedFeedbacks: filtro de rating (A tem 2 notas 5)', async () => {
    expect(await countScopedFeedbacks(A, { rating: 5, search: '', collectionPointIds: null })).toBe(2);
    expect(await countScopedFeedbacks(A, { rating: 1, search: '', collectionPointIds: null })).toBe(0);
  });

  it('countScopedFeedbacks: busca por texto (ilike message)', async () => {
    expect(await countScopedFeedbacks(A, { rating: null, search: 'excelente', collectionPointIds: null })).toBe(1);
  });

  it('fetchScopedFeedbackPage: A retorna 5 feedbacks no shape aninhado', async () => {
    const rows = await fetchScopedFeedbackPage({ enterpriseId: A, filter: noFilter, limit: 10, offset: 0 });
    expect(rows).toHaveLength(5);
    const first = rows[0] as {
      id: string;
      rating: number;
      collection_points: { id: string; catalog_item_id: string | null };
      tracked_devices: unknown;
    };
    expect(first.collection_points.id).toBe(A_POINT);
    expect(first.collection_points.catalog_item_id).toBeNull();
    // ordenado por created_at desc; todos do ponto de A
    expect(rows.every((r) => (r.collection_points as { id: string }).id === A_POINT)).toBe(true);
  });

  it('ISOLAMENTO: página de A nunca traz feedbacks de B (e vice-versa)', async () => {
    const aRows = await fetchScopedFeedbackPage({ enterpriseId: A, filter: noFilter, limit: 100, offset: 0 });
    const bRows = await fetchScopedFeedbackPage({ enterpriseId: B, filter: noFilter, limit: 100, offset: 0 });
    expect(aRows).toHaveLength(5);
    expect(bRows).toHaveLength(2);
    const bMessages = new Set(bRows.map((r) => r.message));
    // nenhuma mensagem de B aparece na página de A
    expect(aRows.some((r) => bMessages.has(r.message))).toBe(false);
  });

  it('paginação: limit/offset recorta corretamente', async () => {
    const page1 = await fetchScopedFeedbackPage({ enterpriseId: A, filter: noFilter, limit: 2, offset: 0 });
    const page2 = await fetchScopedFeedbackPage({ enterpriseId: A, filter: noFilter, limit: 2, offset: 2 });
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    // páginas disjuntas
    const ids1 = new Set(page1.map((r) => r.id));
    expect(page2.some((r) => ids1.has(r.id))).toBe(false);
  });

  it('resolveCategoryCollectionPointIds: COMPANY de A => [ponto de A]; PRODUCT => []', async () => {
    expect(await resolveCategoryCollectionPointIds({ enterpriseId: A, category: 'COMPANY', item: '' })).toEqual([A_POINT]);
    expect(await resolveCategoryCollectionPointIds({ enterpriseId: A, category: 'PRODUCT', item: '' })).toEqual([]);
    expect(await resolveCategoryCollectionPointIds({ enterpriseId: A, category: null, item: '' })).toBeNull();
  });
});
