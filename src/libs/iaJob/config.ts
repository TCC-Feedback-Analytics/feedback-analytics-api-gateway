/**
 * Configuração (por env) do subsistema de fila de análise (etapa 03).
 * Mantida isolada para os controllers/worker lerem o mesmo lugar.
 */

/**
 * Feature flag da transição síncrono → assíncrono. Enquanto `false` (default),
 * os controllers mantêm o caminho síncrono atual; `true` passa a enfileirar
 * (202 + jobId). Permite validar o assíncrono sem quebrar produção.
 */
export function isAsyncEnabled(): boolean {
  return String(process.env.IA_ASYNC_ENABLED ?? '').trim() === 'true';
}

/**
 * Máximo de lotes (chamadas ao LLM) processados por tick do worker. Bound para o
 * drain caber no `maxDuration` da função serverless; o resto continua no próximo
 * tick. Default conservador (3) — ajuste conforme o plano da Vercel/latência.
 */
export function readBatchesPerTick(): number {
  const raw = Number(process.env.IA_WORKER_BATCHES_PER_TICK);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3;
}

/** Limite de chamadas ao LLM por MINUTO (RPM). 0/ausente = sem limite. */
export function readRpmLimit(): number {
  const raw = Number(process.env.IA_RPM_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/** Limite de chamadas ao LLM por DIA (a cota que hoje estoura). 0/ausente = sem limite. */
export function readRpdLimit(): number {
  const raw = Number(process.env.IA_RPD_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}
