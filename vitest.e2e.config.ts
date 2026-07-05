import { defineConfig } from 'vitest/config';

/**
 * Suíte E2E do CUTOVER — sobe o app Express REAL em modo AUTH_PROVIDER=betterauth
 * contra o Postgres local, faz signup/login via Better Auth e exercita os
 * endpoints de dados protegidos por HTTP. Prova a "cola" ponta-a-ponta:
 * sessão Better Auth → requireAuth → enterpriseId → controllers Drizzle.
 *
 * Pré-requisito: `npm run db:local:up` (Postgres + Mailpit). O globalSetup recria
 * o schema + seed. VERCEL=1 evita o app.listen() no import.
 *
 *   npm run test:e2e
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/tests/e2e/**/*.e2e.ts'],
    globalSetup: ['src/tests/integration/globalSetup.ts'],
    env: {
      NODE_ENV: 'test',
      VERCEL: '1',
      AUTH_PROVIDER: 'betterauth',
      DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5433/feedback',
      BETTER_AUTH_SECRET: 'e2e-cutover-secret-please-32-chars-min-xyz',
      BETTER_AUTH_URL: 'http://localhost:3000',
      PUBLIC_SITE_URL: 'http://localhost:5173',
    },
    fileParallelism: false,
    testTimeout: 30000,
  },
});
