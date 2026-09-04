import { drainJobs } from './drainJobs.js';

/** Loop não sobreposto. Aguarda o tick atual no encerramento. */
export function startIaWorker(intervalMs = 3000) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> = Promise.resolve();
  const tick = () => {
    active = (async () => {
      try {
        const result = await drainJobs();
        if (result.processed) console.info('[ia-worker]', JSON.stringify(result));
      } catch {
        console.error('[ia-worker] Falha no tick; nova tentativa no próximo ciclo.');
      } finally {
        if (!stopped) timer = setTimeout(tick, intervalMs);
      }
    })();
  };
  timer = setTimeout(tick, intervalMs);
  return async () => { stopped = true; clearTimeout(timer); await active; };
}
