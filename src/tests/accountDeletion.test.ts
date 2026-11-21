import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  cancelDeletion,
  consumeDeletionToken,
  purgeAccount,
  scheduleDeletion,
} from '../repositories/accountDeletion.repository.js';

const { execute, transaction } = vi.hoisted(() => {
  const execute = vi.fn();
  return { execute, transaction: vi.fn(async (run: (tx: { execute: typeof execute }) => Promise<unknown>) => run({ execute })) };
});
vi.mock('../db/client.js', () => ({ getDb: () => ({ execute, transaction }), closeDb: vi.fn() }));

const dialect = new PgDialect();
const statements = () => execute.mock.calls.map(([query]) => dialect.sqlToQuery(query as SQL));

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockResolvedValue([]);
});

describe('Excluir minha conta: fim do prazo (purgeAccount)', () => {
  it('apaga, numa transação, as tabelas sem cascata, a empresa e por último o usuário', async () => {
    execute.mockResolvedValueOnce([{ email: 'gestor@bompao.com.br' }]);

    await expect(purgeAccount('user-1')).resolves.toBe('gestor@bompao.com.br');

    expect(transaction).toHaveBeenCalledOnce();
    const sqls = statements().map((query) => query.sql.replace(/\s+/g, ' ').trim());
    expect(sqls).toHaveLength(7);
    // A trava da linha do usuário espera um cancelamento em andamento terminar.
    expect(sqls[0]).toMatch(/deletion_scheduled_for <= now\(\) FOR UPDATE$/);
    expect(sqls[1]).toMatch(/^DELETE FROM public\.customer WHERE enterprise_id IN \(SELECT id FROM public\.enterprise WHERE auth_user_id = \$1\)$/);
    expect(sqls[2]).toMatch(/^DELETE FROM public\.collecting_data_enterprise WHERE enterprise_id IN/);
    expect(sqls[3]).toMatch(/^DELETE FROM public\.ia_rate_budget WHERE scope IN/);
    expect(sqls[4]).toBe('DELETE FROM public.verification WHERE value = $1');
    // A empresa leva o resto dela em cascata (feedbacks, análises, catálogo…).
    expect(sqls[5]).toBe('DELETE FROM public.enterprise WHERE auth_user_id = $1');
    expect(sqls[6]).toBe('DELETE FROM public."user" WHERE id = $1');
  });

  it('cada comando só alcança a conta vencida', async () => {
    execute.mockResolvedValueOnce([{ email: 'gestor@bompao.com.br' }]);
    await purgeAccount('user-1');
    for (const query of statements()) expect(query.params).toEqual(['user-1']);
  });

  it('não apaga nada de quem desistiu antes da rotina chegar', async () => {
    await expect(purgeAccount('user-1')).resolves.toBeNull();
    expect(statements()).toHaveLength(1);
  });

  it('recusa sem o id do usuário, sem tocar no banco', async () => {
    await expect(purgeAccount('')).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('Excluir minha conta: confirmação e desistência', () => {
  it('a confirmação marca a data e derruba todas as sessões na mesma transação', async () => {
    execute.mockResolvedValueOnce([{ deletion_scheduled_for: '2026-12-06T12:00:00.000Z' }]);

    await expect(scheduleDeletion('user-1', 15)).resolves.toEqual(new Date('2026-12-06T12:00:00.000Z'));

    expect(transaction).toHaveBeenCalledOnce();
    const [update, sessions] = statements();
    expect(update!.sql).toMatch(/deletion_scheduled_for = now\(\) \+ \$1 \* interval '1 day'/);
    expect(update!.sql).toMatch(/deletion_scheduled_for IS NULL/);
    expect(update!.params).toEqual([15, 'user-1']);
    expect(sessions!.sql).toBe('DELETE FROM public.session WHERE user_id = $1');
  });

  it('uma exclusão já marcada não ganha prazo novo nem mexe nas sessões', async () => {
    await expect(scheduleDeletion('user-1', 15)).resolves.toBeNull();
    expect(statements()).toHaveLength(1);
  });

  it('o link do e-mail só vale uma vez, no prazo e para o dono da sessão', async () => {
    execute.mockResolvedValueOnce([{ id: 'v-1' }]);
    await expect(consumeDeletionToken('user-1', 'hash')).resolves.toBe(true);
    await expect(consumeDeletionToken('user-1', 'hash')).resolves.toBe(false);

    const [query] = statements();
    expect(query!.sql).toMatch(/^\s*DELETE FROM public\.verification/);
    expect(query!.sql).toMatch(/value = \$2 AND expires_at > now\(\)/);
    expect(query!.params).toEqual(['account-deletion:hash', 'user-1']);
  });

  it('desistir limpa a data só de quem tinha exclusão marcada', async () => {
    execute.mockResolvedValueOnce([{ id: 'user-1' }]);
    await expect(cancelDeletion('user-1')).resolves.toBe(true);
    await expect(cancelDeletion('user-1')).resolves.toBe(false);
    expect(statements()[0]!.sql).toMatch(/SET deletion_scheduled_for = NULL/);
  });
});
