import type { Request, Response } from 'express';
import { sendTypedError } from '../../utils/sendTypedError.js';
import {
  API_ERROR_INTERNAL_SERVER_ERROR,
  API_ERROR_UNAUTHORIZED_WORKER_REQUEST,
} from '../../config/errors.js';
import { isWorkerRequestAuthorized } from '../../utils/isWorkerRequestAuthorized.js';
import { drainJobs } from '../../libs/iaJob/drainJobs.js';

/**
 * Tick do worker (etapa 03) — drena um lote de jobs da fila. Chamado
 * periodicamente por um cron externo (não por auth de usuário), protegido pelo
 * `WORKER_TICK_TOKEN`. Responde `{ processed, results }` (útil para logs/telemetria
 * do cron).
 */
export async function workerTickController(req: Request, res: Response) {
  if (!isWorkerRequestAuthorized(req)) {
    return sendTypedError(res, 401, API_ERROR_UNAUTHORIZED_WORKER_REQUEST);
  }

  try {
    const result = await drainJobs();
    return res.json(result);
  } catch (error) {
    console.error('[worker:tick] erro ao drenar jobs:', error);
    return sendTypedError(res, 500, API_ERROR_INTERNAL_SERVER_ERROR);
  }
}
