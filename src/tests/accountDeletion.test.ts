import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { deleteEnterpriseOfUser } from '../auth/enterpriseOnDelete.js';

const { execute, transaction } = vi.hoisted(() => {
  const execute = vi.fn();
  return { execute, transaction: vi.fn(async (run: (tx: { execute: typeof execute }) => Promise<void>) => run({ execute })) };
});
vi.mock('../db/client.js', () => ({ getDb: () => ({ transaction }), closeDb: vi.fn() }));

const dialect = new PgDialect();
const statements = () => execute.mock.calls.map(([query]) => dialect.sqlToQuery(query as SQL));

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockResolvedValue([]);
});

describe('Excluir minha conta: o que sai antes do usuário', () => {
  it('apaga, numa transação, as tabelas sem cascata e por último a empresa', async () => {
    await deleteEnterpriseOfUser('user-1');

    expect(transaction).toHaveBeenCalledOnce();
    const sqls = statements().map((query) => query.sql);
    expect(sqls).toHaveLength(5);
    expect(sqls[0]).toMatch(/^DELETE FROM public\.customer WHERE enterprise_id IN \(SELECT id FROM public\.enterprise WHERE auth_user_id = \$1\)$/);
    expect(sqls[1]).toMatch(/^DELETE FROM public\.collecting_data_enterprise WHERE enterprise_id IN/);
    expect(sqls[2]).toMatch(/^DELETE FROM public\.ia_rate_budget WHERE scope IN/);
    expect(sqls[3]).toBe('DELETE FROM public.verification WHERE value = $1');
    // A empresa por último: o resto dela (feedbacks, análises, catálogo…) vai em cascata.
    expect(sqls[4]).toBe('DELETE FROM public.enterprise WHERE auth_user_id = $1');
  });

  it('cada comando só alcança a empresa do próprio usuário', async () => {
    await deleteEnterpriseOfUser('user-1');
    for (const query of statements()) {
      expect(query.params).toEqual(['user-1']);
    }
  });

  it('recusa sem o id do usuário, sem tocar no banco', async () => {
    await expect(deleteEnterpriseOfUser('')).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
});
