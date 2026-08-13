import type { Request } from 'express';

/**
 * Autoriza o endpoint interno do worker (`POST /api/internal/worker/tick`).
 * Lê `WORKER_TICK_TOKEN`: se vazio, libera (só faz sentido em dev local, mesmo
 * padrão do token interno do ia-analyze); se definido, exige o header
 * `x-worker-token` idêntico. O cron externo envia esse header.
 */
export function isWorkerRequestAuthorized(req: Request): boolean {
  const expected = String(process.env.WORKER_TICK_TOKEN ?? '').trim();
  if (!expected) return true;
  const provided = req.header('x-worker-token');
  return typeof provided === 'string' && provided === expected;
}
