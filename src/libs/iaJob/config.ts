/**
 * Configuração (por env) do subsistema de fila de análise (etapa 03).
 * Mantida isolada para os controllers/worker lerem o mesmo lugar.
 */

/**
 * Máximo de lotes (chamadas ao LLM) processados por tick do worker. Bound para o
 * drain caber no `maxDuration` da função serverless; o resto continua no próximo
 * tick. Default conservador (1) — não é um limite de duração de cada chamada.
 */
export function readBatchesPerTick(): number {
  const raw = Number(process.env.IA_WORKER_BATCHES_PER_TICK);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
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
