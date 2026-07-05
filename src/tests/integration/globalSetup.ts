import { execSync } from 'node:child_process';

const LOCAL_DB = 'postgresql://postgres:postgres@127.0.0.1:5433/feedback';

/**
 * Recria o schema local + seed determinístico (via scripts/db-local.mjs) antes da
 * suíte de integração — garante estado pristino e reprodutível a cada execução.
 * Exige o Postgres local no ar (`npm run db:local:up`).
 */
export default function setup(): void {
  execSync('node scripts/db-local.mjs', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: LOCAL_DB },
  });
}
