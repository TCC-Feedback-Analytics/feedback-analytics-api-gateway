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
