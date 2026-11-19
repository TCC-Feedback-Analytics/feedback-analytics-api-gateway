import { describe, it, expect } from 'vitest';
import { deviceFingerprint, legacyDeviceFingerprint } from '../libs/deviceFingerprint.js';

describe('deviceFingerprint', () => {
  it('é um HMAC-SHA-256 estável para o mesmo navegador e IP', () => {
    const a = deviceFingerprint('Mozilla/5.0', '203.0.113.7');
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(deviceFingerprint('Mozilla/5.0', '203.0.113.7')).toBe(a);
    expect(deviceFingerprint('Mozilla/5.0', '203.0.113.8')).not.toBe(a);
  });

  it('depende do segredo do servidor: com outro segredo, o mesmo aparelho gera outro valor', () => {
    const original = process.env.DEVICE_FINGERPRINT_SECRET;
    const a = deviceFingerprint('Mozilla/5.0', '203.0.113.7');
    process.env.DEVICE_FINGERPRINT_SECRET = 'outro-segredo-de-teste';
    try {
      expect(deviceFingerprint('Mozilla/5.0', '203.0.113.7')).not.toBe(a);
    } finally {
      if (original === undefined) delete process.env.DEVICE_FINGERPRINT_SECRET;
      else process.env.DEVICE_FINGERPRINT_SECRET = original;
    }
  });

  it('o formato antigo continua sendo o MD5 de navegador e IP, só para migrar aparelhos', () => {
    expect(legacyDeviceFingerprint('Mozilla/5.0', '203.0.113.7')).toMatch(/^[a-f0-9]{32}$/);
  });
});