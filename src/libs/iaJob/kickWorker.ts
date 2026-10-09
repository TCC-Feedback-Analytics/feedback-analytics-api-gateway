/**
 * Dispara um passo da fila de IA logo após uma ação do usuário, sem depender do
 * cron (o agendamento do GitHub Actions atrasa horas). A resposta HTTP sai antes:
 * na Vercel, `waitUntil` mantém a Function viva até o passo terminar; localmente
 * o servidor é persistente e a Promise segue em background.
 *
 * Concorrência é segura: cada job é pego com `SKIP LOCKED` + lease, então vários
 * disparos simultâneos (ou disparo + cron + worker local) nunca processam o mesmo
 * passo duas vezes. O cron continua como reserva para jobs sem ninguém olhando.
 */
import { waitUntil } from '@vercel/functions';
import { drainJobs } from './drainJobs.js';
import { hasClaimableIaJob } from '../../repositories/iaJob.repository.js';

function runInBackground(task: () => Promise<void>): void {
  // Testes não sobem banco nem fila real.
  if (process.env.NODE_ENV === 'test') return;

  const run = task().catch(error => {
    console.error('[ia-worker:kick] erro ao drenar jobs:', error);
  });

  if (process.env.VERCEL === '1') {
    waitUntil(run);
    return;
  }

  void run;
}

async function drainOnce(): Promise<void> {
  const result = await drainJobs();
  if (result.processed > 0) console.info('[ia-worker:kick]', JSON.stringify(result.results));
}

/** Processa um passo da fila em background (logo após enfileirar). */
export function kickWorker(): void {
  runInBackground(drainOnce);
}

/**
 * Processa um passo só se a empresa tiver job pronto. Usado ao carregar páginas e
 * no polling de status: recupera jobs parados (aba fechada) e faz jobs de vários
 * passos avançarem a cada consulta, sem esperar o cron.
 */
export function kickWorkerIfPending(enterpriseId: string): void {
  runInBackground(async () => {
    if (await hasClaimableIaJob(enterpriseId)) await drainOnce();
  });
}
