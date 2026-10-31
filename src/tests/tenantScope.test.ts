import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { scopedFeedbackWhere, assertEnterpriseId } from '../db/tenantScope.js';

// Compila a condição WHERE para SQL + params SEM tocar no banco — prova que o
// helper sempre injeta o enterprise_id e nunca vaza dados entre empresas.
const dialect = new PgDialect();
function compile(condition: SQL): { sql: string; params: unknown[] } {
  const { sql, params } = dialect.sqlToQuery(condition);
  return { sql, params };
}

describe('[Unit] tenantScope — isolamento multi-tenant', () => {
  it('a query SEMPRE filtra por enterprise_id', () => {
    const { sql, params } = compile(scopedFeedbackWhere('ent-A', null));
    expect(sql).toMatch(/enterprise_id"?\s*=\s*\$1/);
    expect(params).toEqual(['ent-A']);
  });

  it('empresas diferentes geram parâmetros diferentes (A nunca enxerga B)', () => {
    expect(compile(scopedFeedbackWhere('ent-A', null)).params).toEqual(['ent-A']);
    expect(compile(scopedFeedbackWhere('ent-B', null)).params).toEqual(['ent-B']);
  });

  it('o recorte por escopo (collection_point_id) NÃO remove o filtro de empresa', () => {
    const { sql, params } = compile(scopedFeedbackWhere('ent-A', ['cp-1', 'cp-2']));
    expect(sql).toMatch(/enterprise_id/);
    expect(sql).toMatch(/collection_point_id/);
    // enterprise_id primeiro, depois os ids do escopo — empresa sempre presente.
    expect(params).toEqual(['ent-A', 'cp-1', 'cp-2']);
  });

  it('o período recorta created_at com início incluído e fim excluído', () => {
    const { sql, params } = compile(
      scopedFeedbackWhere('ent-A', ['cp-1'], { start: '2026-09-17T03:00:00.000Z', end: '2026-10-17T03:00:00.000Z' }),
    );
    expect(sql).toMatch(/created_at"?\s*>=\s*\$3/);
    expect(sql).toMatch(/created_at"?\s*<\s*\$4/);
    expect(params).toEqual(['ent-A', 'cp-1', '2026-09-17T03:00:00.000Z', '2026-10-17T03:00:00.000Z']);
  });

  it('sem período a query segue como antes', () => {
    const { sql } = compile(scopedFeedbackWhere('ent-A', null, { start: null, end: null }));
    expect(sql).not.toMatch(/created_at/);
  });

  it('deixa de fora os feedbacks do "Testar o formulário", sem mudar os parâmetros', () => {
    const { sql, params } = compile(scopedFeedbackWhere('ent-A', ['cp-1']));
    // IS DISTINCT FROM mantém os feedbacks sem canal (anteriores à marca).
    expect(sql).toMatch(/channel"? IS DISTINCT FROM 'TEST'/);
    expect(params).toEqual(['ent-A', 'cp-1']);
  });

  it('a lista de feedbacks pode incluir os testes', () => {
    const { sql } = compile(scopedFeedbackWhere('ent-A', null, null, { includeTests: true }));
    expect(sql).not.toMatch(/channel/);
  });

  it('recusa enterprise_id vazio — não permite query sem tenant', () => {
    expect(() => scopedFeedbackWhere('', null)).toThrow();
    expect(() => assertEnterpriseId('')).toThrow();
  });
});
