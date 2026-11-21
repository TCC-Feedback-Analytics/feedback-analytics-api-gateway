import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { getTableColumns } from 'drizzle-orm';
import { trackedDevices } from '../../drizzle/schema.js';
import { deviceFingerprint } from '../libs/deviceFingerprint.js';

// LGPD, art. 6º, III (necessidade): o navegador e o IP de quem responde ao formulário só servem
// para calcular o identificador do aparelho na hora. O banco guarda apenas o HMAC.
describe('aparelho do formulário público sem IP nem navegador', () => {
  it('a tabela tracked_devices não tem colunas de IP nem de navegador', () => {
    const colunas = Object.values(getTableColumns(trackedDevices)).map((coluna) => coluna.name);
    expect(colunas).toContain('device_fingerprint');
    expect(colunas).not.toContain('ip_address');
    expect(colunas).not.toContain('user_agent');
  });

  it('a migration 0017 apaga as colunas antigas e a função que gravava nelas', () => {
    const sql = readFileSync(new URL('../../drizzle/0017_aparelho_sem_ip_navegador.sql', import.meta.url), 'utf8');
    expect(sql).toMatch(/DROP COLUMN "user_agent"/);
    expect(sql).toMatch(/DROP COLUMN "ip_address"/);
    expect(sql).toMatch(/DROP FUNCTION IF EXISTS public\.register_device_feedback/);
  });

  it('o identificador não deixa ver o IP nem o navegador', () => {
    process.env.DEVICE_FINGERPRINT_SECRET = 'segredo-de-teste';
    const id = deviceFingerprint('Mozilla/5.0 (Android 14)', '203.0.113.7');
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toContain('203.0.113.7');
    expect(id).not.toContain('Mozilla');
  });
});
