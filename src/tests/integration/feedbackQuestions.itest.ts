import { describe, it, expect, afterAll } from 'vitest';
import {
  fetchQuestionDefsScoped,
  fetchSubquestionDefsScoped,
} from '../../repositories/feedbackQuestions.repository.js';
import { closeDb } from '../../db/client.js';

// UUIDs fixos do seed (db/local/seed.sql).
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000001';
const Q_A1 = 'dddddddd-0000-0000-0000-0000000000a1';
const Q_A2 = 'dddddddd-0000-0000-0000-0000000000a2';
const NON_EXISTENT = '11111111-2222-3333-4444-555555555555';

afterAll(async () => {
  await closeDb();
});

describe('[Integração] fetchQuestionDefsScoped — config de perguntas por tenant', () => {
  it('empresa A resolve suas perguntas por id', async () => {
    const defs = await fetchQuestionDefsScoped(A, [Q_A1, Q_A2]);
    expect(defs.map((d) => d.id).sort()).toEqual([Q_A1, Q_A2].sort());
    expect(defs.every((d) => d.isActive)).toBe(true);
  });

  it('ISOLAMENTO: empresa B NÃO enxerga as perguntas de A, mesmo passando os ids', async () => {
    const defs = await fetchQuestionDefsScoped(B, [Q_A1, Q_A2]);
    expect(defs).toEqual([]);
  });

  it('lista de ids vazia => [] (sem query)', async () => {
    expect(await fetchQuestionDefsScoped(A, [])).toEqual([]);
  });

  it('fetchSubquestionDefsScoped roda o JOIN de tenant; id inexistente => []', async () => {
    expect(await fetchSubquestionDefsScoped(A, [NON_EXISTENT])).toEqual([]);
  });
});
