import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/tests/**/*.test.ts'],
    env: {
      VERCEL: '1',
      NODE_ENV: 'test',
      // O index.ts monta getAuth() no import (Better Auth) → precisa destas envs
      // mesmo nos testes unitários que importam o app. Nenhum teste unitário
      // consulta o banco de verdade (mockam repos/getAuth), então o DATABASE_URL
      // só serve para o getDb() instanciar sem lançar.
      DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5433/feedback',
      BETTER_AUTH_SECRET: 'unit-test-secret-please-32-chars-minimum-xyz',
      BETTER_AUTH_URL: 'http://localhost:3000',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/tests/**'],
    },
  },
});
