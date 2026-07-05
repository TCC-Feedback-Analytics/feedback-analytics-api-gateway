import { describe, it, expect, afterAll } from 'vitest';
import { fetchActiveQuestionsForScope } from '../../repositories/publicQuestions.repository.js';
import { closeDb } from '../../db/client.js';

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000001';

afterAll(async () => {
  await closeDb();
});

describe('[Integração] fetchActiveQuestionsForScope — perguntas públicas + isolamento', () => {
  it('A COMPANY: 2 perguntas ativas ordenadas; shape { data, error }', async () => {
    const res = await fetchActiveQuestionsForScope({ enterpriseId: A, scopeType: 'COMPANY', catalogItemId: null });
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(2);
    expect(res.data?.[0]?.question_order).toBe(1);
    expect(res.data?.[0]?.scope_type).toBe('COMPANY');
    expect(res.data?.[0]?.catalog_item_id).toBeNull();
    expect(Array.isArray(res.data?.[0]?.subquestions)).toBe(true);
  });

  it('ISOLAMENTO: B (sem perguntas) COMPANY => [] (não vê as de A)', async () => {
    const res = await fetchActiveQuestionsForScope({ enterpriseId: B, scopeType: 'COMPANY', catalogItemId: null });
    expect(res.error).toBeNull();
    expect(res.data).toEqual([]);
  });

  it('A PRODUCT (sem perguntas de produto no seed) => []', async () => {
    const res = await fetchActiveQuestionsForScope({ enterpriseId: A, scopeType: 'PRODUCT', catalogItemId: null });
    expect(res.data).toEqual([]);
  });
});
