import { defineConfig } from 'vitest/config';

/**
 * Suíte de INTEGRAÇÃO — roda contra o Postgres LOCAL (docker-compose, :5433),
 * sem mocks. É onde a Fase 2 prova o isolamento por tenant das queries Drizzle.
 *
 * Pré-requisito: `npm run db:local:up` (Postgres + Mailpit no ar). O globalSetup
 * recria o schema + seed determinístico antes da suíte.
 *
 *   npm run test:integration
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/tests/integration/**/*.itest.ts'],
    globalSetup: ['src/tests/integration/globalSetup.ts'],
    env: {
      NODE_ENV: 'test',
      AUTH_PROVIDER: 'betterauth',
      DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5433/feedback',
    },
    // Mesmo banco compartilhado → roda serial para evitar interferência.
    fileParallelism: false,
    testTimeout: 20000,
  },
});
