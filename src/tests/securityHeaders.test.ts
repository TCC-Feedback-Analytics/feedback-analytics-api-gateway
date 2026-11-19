import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../index.js';

describe('Cabeçalhos de segurança do gateway', () => {
  it('toda resposta sai com CSP fechada, X-Frame-Options, nosniff, Referrer-Policy, HSTS e Permissions-Policy', async () => {
    const res = await request(app).get('/api/health');

    expect(res.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(res.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  });
});