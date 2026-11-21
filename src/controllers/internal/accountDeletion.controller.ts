import type { Request, Response } from 'express';
import {
  API_ERROR_INTERNAL_SERVER_ERROR,
  API_ERROR_UNAUTHORIZED_WORKER_REQUEST,
} from '../../config/errors.js';
import { purgeAccountsDueForDeletion } from '../../services/accountDeletion.service.js';
import { describeError } from '../../utils/describeError.js';
import { isWorkerRequestAuthorized } from '../../utils/isWorkerRequestAuthorized.js';
import { sendTypedError } from '../../utils/sendTypedError.js';

/**
 * Fim da carência de "Excluir minha conta": apaga as contas com o prazo vencido.
 * Chamado uma vez por dia pelo workflow `exclusao-de-contas.yml`, com o mesmo
 * `WORKER_TICK_TOKEN` do worker da IA. Responde `{ deleted, failed }` para os logs.
 */
export async function purgeAccountsController(req: Request, res: Response) {
  if (!isWorkerRequestAuthorized(req)) {
    return sendTypedError(res, 401, API_ERROR_UNAUTHORIZED_WORKER_REQUEST);
  }

  try {
    return res.json(await purgeAccountsDueForDeletion());
  } catch (error) {
    console.error('[account-deletion:purge] erro ao buscar as contas vencidas:', describeError(error));
    return sendTypedError(res, 500, API_ERROR_INTERNAL_SERVER_ERROR);
  }
}
