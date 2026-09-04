import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { updateIaModel, type IaConfigRow } from '../repositories/iaConfig.repository.js';
import { enterpriseIaConfig } from '../../drizzle/schema.js';

const { query, getDb } = vi.hoisted(() => {
  const query = { update: vi.fn(), set: vi.fn(), where: vi.fn(), returning: vi.fn() };
  return { query, getDb: vi.fn(() => query) };
});
vi.mock('../db/client.js', () => ({ getDb }));

const expected: IaConfigRow = {
  id: 'config-1', enterpriseId: 'ent-A', provider: 'openrouter', model: 'old/model',
  apiKeyCiphertext: 'cipher-1', apiKeyIv: 'iv-1', apiKeyAuthTag: 'tag-1', keyHint: '1234',
};

beforeEach(() => {
  vi.clearAllMocks();
  query.update.mockReturnValue(query);
  query.set.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.returning.mockResolvedValue([{ provider: 'openrouter', model: 'new/model', keyHint: '1234' }]);
});

describe('Repositório IA — atualização atômica somente do modelo', () => {
  it('SET só contém model e WHERE exige empresa, id, credenciais e modelo anterior', async () => {
    const result = await updateIaModel('ent-A', expected, 'new/model');
    expect(query.update).toHaveBeenCalledWith(enterpriseIaConfig);
    expect(query.set).toHaveBeenCalledWith({ model: 'new/model' });
    const where = query.where.mock.calls[0][0] as SQL;
    const { sql, params } = new PgDialect().sqlToQuery(where);
    expect(sql).toContain('"enterprise_id" = $1');
    expect(sql).toContain('"id" = $2');
    expect(sql).toContain('"provider" = $3');
    expect(sql).toContain('"api_key_ciphertext" = $4');
    expect(sql).toContain('"api_key_iv" = $5');
    expect(sql).toContain('"api_key_auth_tag" = $6');
    expect(sql).toContain('"model" = $7');
    expect(params).toEqual(['ent-A', 'config-1', 'openrouter', 'cipher-1', 'iv-1', 'tag-1', 'old/model']);
    expect(Object.keys(query.returning.mock.calls[0][0])).toEqual(['provider', 'model', 'keyHint']);
    expect(result).toEqual({ hasKey: true, provider: 'openrouter', model: 'new/model', keyHint: '1234' });
  });

  it('não pode atingir outro tenant mesmo com snapshot da empresa A', async () => {
    query.returning.mockResolvedValueOnce([]);
    expect(await updateIaModel('ent-B', expected, 'new/model')).toBeNull();
    const { params } = new PgDialect().sqlToQuery(query.where.mock.calls[0][0] as SQL);
    expect(params[0]).toBe('ent-B');
    expect(params[1]).toBe('config-1');
  });

  it('modelo legado null usa IS NULL e remoção/troca concorrente retorna null', async () => {
    query.returning.mockResolvedValueOnce([]);
    expect(await updateIaModel('ent-A', { ...expected, model: null }, 'new/model')).toBeNull();
    const { sql, params } = new PgDialect().sqlToQuery(query.where.mock.calls[0][0] as SQL);
    expect(sql).toContain('"model" is null');
    expect(params).toHaveLength(6);
    expect(query.update).toHaveBeenCalledTimes(1);
  });

  it.each(['apiKeyCiphertext', 'apiKeyIv', 'apiKeyAuthTag'] as const)('sem %s não acessa banco', async (field) => {
    expect(await updateIaModel('ent-A', { ...expected, [field]: null }, 'new/model')).toBeNull();
    expect(getDb).not.toHaveBeenCalled();
  });

  it('recusa atualização sem tenant', async () => {
    await expect(updateIaModel('', expected, 'new/model')).rejects.toThrow();
    expect(query.returning).not.toHaveBeenCalled();
  });
});
