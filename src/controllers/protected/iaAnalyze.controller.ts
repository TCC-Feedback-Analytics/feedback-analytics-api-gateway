import type { Request, Response } from 'express';
import { API_ERROR_INTERNAL_SERVER_ERROR, API_ERROR_IA_JOB_NOT_FOUND } from '../../config/errors.js';
import { sendTypedError } from '../../utils/sendTypedError.js';
import type {
  IaAnalyzeRawRunRequest,
  IaAnalyzeRawRunResponse,
  IaAnalyzeRegenerateInsightsRequest,
  IaAnalyzeRegenerateInsightsResponse,
} from '@feedback/lib-shared/interfaces/contracts/ia-analyze/run.contract';
import {
  analyzeRawFeedbacks,
  regenerateFeedbackInsights,
} from '../../services/iaAnalyze.service.js';
import { resolveEnterpriseIdByUser } from '../../repositories/enterprise.repository.js';
import { IaAnalyzeServiceError } from '../../libs/iaAnalyze/errors.js';
import { parseScopeType } from '../../libs/iaAnalyze/parse.js';
import { readExecutionMode } from '../../libs/iaAnalyze/readEnvs.js';
import { resolvePrimaryBaseUrl } from '../../libs/iaAnalyze/resolvePrimaryBaseUrl.js';
import { enqueueIaJob, getIaJobByIdScoped } from '../../repositories/iaJob.repository.js';
import { isAsyncEnabled } from '../../libs/iaJob/config.js';

/**
 * Loga, de forma estruturada, o contexto de uma falha no fluxo de IA. Inclui o
 * código tipado, o modo de execução, a base URL resolvida e o tempo decorrido —
 * o suficiente para, só pelos logs do Vercel, distinguir as causas de um 502:
 * config remota ausente (baseUrl=localhost / mode=local), timeout do remoto
 * (elapsedMs alto + failed_remote_ia_analyze_request) ou erro do próprio modelo.
 */
function logIaAnalyzeFailure(label: string, startedAt: number, error: unknown) {
  const elapsedMs = Date.now() - startedAt;
  const code = error instanceof IaAnalyzeServiceError ? error.code : 'unexpected_error';
  const statusCode = error instanceof IaAnalyzeServiceError ? error.statusCode : 500;

  let baseUrl = 'unresolved';
  try {
    baseUrl = resolvePrimaryBaseUrl();
  } catch {
    baseUrl = 'unresolved';
  }

  console.error(
    `[ia-analyze:${label}] code=${code} status=${statusCode} mode=${readExecutionMode()} baseUrl=${baseUrl} elapsedMs=${elapsedMs}`,
    error,
  );
}

/**
 * Controller responsável por orquestrar a análise IA de feedbacks brutos via requisição HTTP.
 *
 * Etapas principais:
 * 1. Extrai e valida parâmetros do corpo da requisição.
 * 2. Chama o serviço de análise IA para feedbacks brutos.
 * 3. Retorna o resultado da análise ou erro tipado.
 *
 * Útil para expor a análise IA de feedbacks brutos via API REST, garantindo tratamento de erros e validação de entrada.
 */
export async function analyzeRawFeedbacksController(req: Request, res: Response) {
  const user = req.user!;
  const body = (req.body ?? {}) as IaAnalyzeRawRunRequest;

  const limit =
    typeof body.limit === 'number' && body.limit > 0 ? body.limit : undefined;
  const scope_type = parseScopeType(body.scope_type);
  const catalog_item_id =
    typeof body.catalog_item_id === 'string' && body.catalog_item_id.trim().length > 0
      ? body.catalog_item_id.trim()
      : undefined;

  const startedAt = Date.now();

  try {
    const enterpriseId = req.enterpriseId ?? (await resolveEnterpriseIdByUser(user.id));
    if (!enterpriseId) {
      throw new IaAnalyzeServiceError('Enterprise not found', 404, 'enterprise_not_found');
    }

    if (isAsyncEnabled()) {
      const { jobId, status } = await enqueueIaJob({
        enterpriseId,
        jobType: 'analyze_raw',
        scopeType: scope_type,
        catalogItemId: catalog_item_id ?? null,
        requestedBy: user.id,
        options: { limit },
      });
      return res.status(202).json({ jobId, status });
    }

    const result = await analyzeRawFeedbacks({
      enterpriseId,
      options: { limit, scope_type, catalog_item_id },
    });

    return res.json(result satisfies IaAnalyzeRawRunResponse);
  } catch (error) {
    logIaAnalyzeFailure('analyze-raw', startedAt, error);

    if (error instanceof IaAnalyzeServiceError) {
      return sendTypedError(res, error.statusCode, error.code);
    }

    return sendTypedError(res, 500, API_ERROR_INTERNAL_SERVER_ERROR);
  }
}

/**
 * Controller responsável por regenerar os insights IA de feedbacks via requisição HTTP.
 *
 * Etapas principais:
 * 1. Extrai e valida parâmetros do corpo da requisição.
 * 2. Chama o serviço para regenerar os insights IA.
 * 3. Retorna o resultado da operação ou erro tipado.
 *
 * Útil para atualizar os insights globais/segmentados de feedbacks via API REST, garantindo tratamento de erros e validação de entrada.
 */
export async function regenerateFeedbackInsightsController(req: Request, res: Response) {
  const user = req.user!;
  const body = (req.body ?? {}) as IaAnalyzeRegenerateInsightsRequest;

  const scope_type = parseScopeType(body.scope_type);
  const catalog_item_id =
    typeof body.catalog_item_id === 'string' && body.catalog_item_id.trim().length > 0
      ? body.catalog_item_id.trim()
      : undefined;
  const force = body.force === true;

  const startedAt = Date.now();

  try {
    const enterpriseId = req.enterpriseId ?? (await resolveEnterpriseIdByUser(user.id));
    if (!enterpriseId) {
      throw new IaAnalyzeServiceError('Enterprise not found', 404, 'enterprise_not_found');
    }

    if (isAsyncEnabled()) {
      const { jobId, status } = await enqueueIaJob({
        enterpriseId,
        jobType: 'regenerate_insights',
        scopeType: scope_type,
        catalogItemId: catalog_item_id ?? null,
        requestedBy: user.id,
        options: { force },
      });
      return res.status(202).json({ jobId, status });
    }

    const result = await regenerateFeedbackInsights({
      enterpriseId,
      options: { scope_type, catalog_item_id, force },
    });

    return res.json(result satisfies IaAnalyzeRegenerateInsightsResponse);
  } catch (error) {
    logIaAnalyzeFailure('regenerate-insights', startedAt, error);

    if (error instanceof IaAnalyzeServiceError) {
      return sendTypedError(res, error.statusCode, error.code);
    }

    return sendTypedError(res, 500, API_ERROR_INTERNAL_SERVER_ERROR);
  }
}

// Regex leve para barrar ids não-uuid antes de tocar o banco (evita erro de
// sintaxe uuid do Postgres e responde 404 limpo).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Polling do progresso de um job de análise (etapa 03). Escopado por empresa:
 * um gestor nunca enxerga o job de outra empresa (isolamento app-level por
 * enterprise_id). Responde `{ id, status, total, done, ... }`.
 */
export async function getIaJobController(req: Request, res: Response) {
  const user = req.user!;
  const jobId = String(req.params.id ?? '');

  try {
    const enterpriseId = req.enterpriseId ?? (await resolveEnterpriseIdByUser(user.id));
    if (!enterpriseId) {
      throw new IaAnalyzeServiceError('Enterprise not found', 404, 'enterprise_not_found');
    }

    if (!UUID_RE.test(jobId)) {
      return sendTypedError(res, 404, API_ERROR_IA_JOB_NOT_FOUND);
    }

    const job = await getIaJobByIdScoped({ enterpriseId, jobId });
    if (!job) {
      return sendTypedError(res, 404, API_ERROR_IA_JOB_NOT_FOUND);
    }

    return res.json(job);
  } catch (error) {
    if (error instanceof IaAnalyzeServiceError) {
      return sendTypedError(res, error.statusCode, error.code);
    }
    return sendTypedError(res, 500, API_ERROR_INTERNAL_SERVER_ERROR);
  }
}
