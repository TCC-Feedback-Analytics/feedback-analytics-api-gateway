import { describe, it, expect, afterAll } from 'vitest';
import { resolveEnterpriseIdByUser } from '../../repositories/enterprise.repository.js';
import { closeDb } from '../../db/client.js';

// UUIDs fixos do seed (db/local/seed.sql).
const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const ENTERPRISE_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ENTERPRISE_B = 'bbbbbbbb-0000-0000-0000-000000000001';
const USER_GHOST = '99999999-9999-9999-9999-999999999999';

afterAll(async () => {
  await closeDb();
});

describe('[Integração] resolveEnterpriseIdByUser — resolução tenant-safe', () => {
  it('usuário A resolve para a empresa A', async () => {
    expect(await resolveEnterpriseIdByUser(USER_A)).toBe(ENTERPRISE_A);
  });

  it('usuário B resolve para a empresa B (nunca a de A)', async () => {
    const id = await resolveEnterpriseIdByUser(USER_B);
    expect(id).toBe(ENTERPRISE_B);
    expect(id).not.toBe(ENTERPRISE_A);
  });

  it('usuário sem empresa => null (não vaza empresa de ninguém)', async () => {
    expect(await resolveEnterpriseIdByUser(USER_GHOST)).toBeNull();
  });
});
