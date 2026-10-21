import type { Request, Response } from 'express';
import {
  API_ERROR_ENTERPRISE_NOT_FOUND,
  API_ERROR_INTERNAL_SERVER_ERROR,
  API_ERROR_INVALID_PAYLOAD,
  API_ERROR_INVALID_PERIOD,
  API_ERROR_INVALID_TIMELINE,
  API_ERROR_SCOPE_DIAGNOSIS_NOT_FOUND,
} from '../../config/errors.js';
import { sendTypedError } from '../../utils/sendTypedError.js';
import { IaAnalyzeServiceError } from '../../libs/iaAnalyze/errors.js';
import { parseScopeType } from '../../libs/iaAnalyze/parse.js';
import { parseMetricsPeriod } from '../../libs/period.js';
import { parseTimezone } from '../../libs/timeline.js';
import { kickWorkerIfPending } from '../../libs/iaJob/kickWorker.js';
import { resolveEnterpriseIdByUser } from '../../repositories/enterprise.repository.js';
import { getIaJobByIdScoped, listActiveIaJobsForTypeScoped } from '../../repositories/iaJob.repository.js';
import {
  fetchLatestScopeDiagnosis,
  fetchScopeDiagnosisById,
  listScopeDiagnoses,
} from '../../repositories/scopeDiagnosis.repository.js';
import { requestScopeDiagnosis, toScopeDiagnosis } from '../../services/scopeDiagnosis.service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `undefined` = ausente; `null` = inválido. */
function parseCatalogItemId(raw: unknown): string | null | undefined {
  const value = String(raw ?? '').trim();
  if (!value) return undefined;
  return UUID_RE.test(value) ? value : null;
}

function readScope(source: Record<string, unknown>) {
  const scopeType = parseScopeType(source.scope_type ?? 'COMPANY');
  const catalogItemId = parseCatalogItemId(source.catalog_item_id);
  if (!scopeType || catalogItemId === null || (scopeType === 'COMPANY' && catalogItemId)) return null;
  return { scopeType, catalogItemId: catalogItemId ?? null };
}

async function enterpriseOf(req: Request): Promise<string | null> {
  return req.enterpriseId ?? (await resolveEnterpriseIdByUser(req.user!.id));
}

function sendFailure(res: Response, label: string, error: unknown) {
  if (error instanceof IaAnalyzeServiceError) return sendTypedError(res, error.statusCode, error.code);
  console.error(`[scope-diagnosis] ${label}:`, error);
  return sendTypedError(res, 500, API_ERROR_INTERNAL_SERVER_ERROR);
}

/**
 * Pede o diagnóstico do escopo no período. 200 com `cached: true` quando o mesmo
 * recorte com os mesmos dados já tem diagnóstico; senão 202 com o job.
 */
export async function requestScopeDiagnosisController(req: Request, res: Response) {
  res.setHeader('Cache-Control', 'private, no-store');
  const body = (req.body ?? {}) as Record<string, unknown>;
  const scope = readScope(body);
  if (!scope) return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD);
  const parsedPeriod = parseMetricsPeriod(body);
  if ('error' in parsedPeriod) return sendTypedError(res, 400, API_ERROR_INVALID_PERIOD);
  const timeZone = parseTimezone(body.tz);
  if (!timeZone) return sendTypedError(res, 400, API_ERROR_INVALID_TIMELINE);

  try {
    const enterpriseId = await enterpriseOf(req);
    if (!enterpriseId) return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);
    const accepted = await requestScopeDiagnosis({
      enterpriseId,
      userId: req.user!.id,
      ...scope,
      period: parsedPeriod.period,
      timeZone,
      force: body.force === true,
    });
    return res.status(accepted.cached ? 200 : 202).json(accepted);
  } catch (error) {
    return sendFailure(res, 'request', error);
  }
}

/** O diagnóstico mais recente do escopo e, se houver, o job em andamento. */
export async function getLatestScopeDiagnosisController(req: Request, res: Response) {
  res.setHeader('Cache-Control', 'private, no-store');
  const scope = readScope(req.query as Record<string, unknown>);
  if (!scope) return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD);

  try {
    const enterpriseId = await enterpriseOf(req);
    if (!enterpriseId) return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);
    const [row, jobs] = await Promise.all([
      fetchLatestScopeDiagnosis({ enterpriseId, ...scope }),
      listActiveIaJobsForTypeScoped(enterpriseId, 'generate_scope_diagnosis'),
    ]);
    const active = jobs.find((job) => job.scopeType === scope.scopeType && job.catalogItemId === scope.catalogItemId);
    const job = active ? await getIaJobByIdScoped({ enterpriseId, jobId: active.id }) : null;
    if (job) kickWorkerIfPending(enterpriseId);
    return res.json({ diagnosis: row ? await toScopeDiagnosis(enterpriseId, row) : null, job });
  } catch (error) {
    return sendFailure(res, 'latest', error);
  }
}

/** Histórico do escopo, só com o resumo de cada diagnóstico. */
export async function listScopeDiagnosesController(req: Request, res: Response) {
  res.setHeader('Cache-Control', 'private, no-store');
  const scope = readScope(req.query as Record<string, unknown>);
  if (!scope) return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD);

  try {
    const enterpriseId = await enterpriseOf(req);
    if (!enterpriseId) return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);
    const rows = await listScopeDiagnoses({ enterpriseId, ...scope });
    return res.json({
      items: rows.map((row) => ({
        id: row.id,
        period: { start: row.periodStart && new Date(Date.parse(row.periodStart)).toISOString(), end: row.periodEnd && new Date(Date.parse(row.periodEnd)).toISOString() },
        feedbackCount: row.feedbackCount,
        model: row.model,
        createdAt: new Date(Date.parse(row.createdAt)).toISOString(),
        summary: row.result.summary,
      })),
    });
  } catch (error) {
    return sendFailure(res, 'list', error);
  }
}

/** Um diagnóstico do histórico, completo. */
export async function getScopeDiagnosisController(req: Request, res: Response) {
  res.setHeader('Cache-Control', 'private, no-store');
  const id = String(req.params.id ?? '');
  if (!UUID_RE.test(id)) return sendTypedError(res, 404, API_ERROR_SCOPE_DIAGNOSIS_NOT_FOUND);

  try {
    const enterpriseId = await enterpriseOf(req);
    if (!enterpriseId) return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);
    const row = await fetchScopeDiagnosisById(enterpriseId, id);
    if (!row) return sendTypedError(res, 404, API_ERROR_SCOPE_DIAGNOSIS_NOT_FOUND);
    return res.json(await toScopeDiagnosis(enterpriseId, row));
  } catch (error) {
    return sendFailure(res, 'get', error);
  }
}
