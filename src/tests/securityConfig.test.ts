/**
 * Configuração de segurança do Gateway: sessões ao trocar a senha, origens
 * localhost só fora de produção (CORS e Better Auth), o cabeçalho X-Powered-By e as
 * rotas nativas de e-mail e senha desligadas.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import type { BetterAuthOptions } from 'better-auth';
import { buildTrustedOrigins, DISABLED_NATIVE_AUTH_PATHS, getAuth } from '../auth/auth.js';

const LOCALHOST = ['http://localhost:5173', 'http://localhost:4173'];

describe('sessões ao trocar a senha', () => {
  it('a nova senha encerra todas as sessões da pessoa', () => {
    const options: BetterAuthOptions = getAuth().options;
    expect(options.emailAndPassword?.revokeSessionsOnPasswordReset).toBe(true);
  });
});

describe('origens confiáveis do Better Auth', () => {
  it('em produção ficam só o site e as origens configuradas, sem localhost', () => {
    const origins = buildTrustedOrigins({
      NODE_ENV: 'production',
      PUBLIC_SITE_URL: 'https://feedback.exemplo.com',
      CORS_ALLOWED_ORIGINS: 'https://app.exemplo.com',
    });
    expect(origins).toEqual(['https://feedback.exemplo.com', 'https://app.exemplo.com']);
  });

  it('fora de produção aceitam a Web local', () => {
    expect(buildTrustedOrigins({ NODE_ENV: 'development' })).toEqual(LOCALHOST);
  });
});

describe('CORS e cabeçalhos do app', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadApp(nodeEnv: string) {
    vi.stubEnv('NODE_ENV', nodeEnv);
    vi.stubEnv('PUBLIC_SITE_URL', 'https://feedback.exemplo.com');
    // Definidas aqui para o .env local (lido pelo dotenv no index.ts) não entrar no teste.
    vi.stubEnv('CORS_ALLOWED_ORIGINS', '');
    vi.stubEnv('CORS_ALLOW_VERCEL_PROJECT_PAIR', 'false');
    vi.resetModules();
    return (await import('../../index.js')).default;
  }

  it('em produção o navegador em localhost não recebe permissão de CORS', async () => {
    const app = await loadApp('production');

    const preflight = await request(app).options('/api/health').set('Origin', 'http://localhost:5173');
    expect(preflight.status).toBe(403);

    const get = await request(app).get('/api/health').set('Origin', 'http://localhost:4173');
    expect(get.headers['access-control-allow-origin']).toBeUndefined();

    const site = await request(app).get('/api/health').set('Origin', 'https://feedback.exemplo.com');
    expect(site.headers['access-control-allow-origin']).toBe('https://feedback.exemplo.com');
  });

  it('fora de produção a Web local continua com CORS', async () => {
    const app = await loadApp('test');
    const res = await request(app).get('/api/health').set('Origin', 'http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('não anuncia o Express no X-Powered-By', async () => {
    const app = await loadApp('test');
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('rotas nativas de e-mail e senha do Better Auth', () => {
  afterEach(() => {
    vi.resetModules();
  });

  async function loadApp() {
    vi.resetModules();
    return (await import('../../index.js')).default;
  }

  it('respondem 404: o login, o cadastro e a recuperação só passam pelo gateway, com o limite no banco', async () => {
    const app = await loadApp();
    for (const path of DISABLED_NATIVE_AUTH_PATHS) {
      const res = await request(app)
        .post(`/api/auth${path}`)
        .send({ email: 'gestor@bompao.com.br', password: 'Gato!Verde!Pulou', newPassword: 'Gato!Verde!Pulou', token: 'tok' });
      expect(res.status, path).toBe(404);
    }
  });

  it('as rotas nativas que a Web e os e-mails usam continuam abertas', async () => {
    const usedByWebOrEmails = [
      '/sign-in/social',
      '/callback/google',
      '/verify-email',
      '/reset-password/:token',
      '/list-accounts',
      '/delete-user',
      '/sign-out',
      '/get-session',
    ];
    for (const path of usedByWebOrEmails) expect(DISABLED_NATIVE_AUTH_PATHS).not.toContain(path);

    const app = await loadApp();
    const res = await request(app).get('/api/auth/ok');
    expect(res.status).toBe(200);
  });
});
