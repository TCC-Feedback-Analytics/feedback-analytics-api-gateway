import type { Request, Response } from 'express';
import { z } from 'zod';
import { resolveEnterpriseIdByUser } from '../../repositories/enterprise.repository.js';
import { requestCompanyQuestionSuggestions } from '../../services/companyQuestionSuggestions.service.js';
import { getCompanyQuestionSuggestions, QuestionSuggestionsRateLimitError } from '../../repositories/companyQuestionSuggestions.repository.js';
import { IaAnalyzeServiceError } from '../../libs/iaAnalyze/errors.js';
import { sendTypedError } from '../../utils/sendTypedError.js';

function sendFailure(res: Response, error: unknown) {
  if (error instanceof QuestionSuggestionsRateLimitError) {
    res.setHeader('Retry-After', String(error.retryAfterSeconds));
    return sendTypedError(res, 429, error.code, { retryAfterSeconds: error.retryAfterSeconds });
  }
  if (error instanceof IaAnalyzeServiceError) return sendTypedError(res, error.statusCode, error.code);
  console.error('[company-question-suggestions] operation_failed');
  return sendTypedError(res, 503, 'service_unavailable');
}

export async function requestCompanyQuestionSuggestionsController(req: Request, res: Response) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!z.object({}).strict().safeParse(req.body ?? {}).success) return sendTypedError(res, 400, 'invalid_payload');
  try {
    const enterpriseId = req.enterpriseId ?? await resolveEnterpriseIdByUser(req.user!.id);
    if (!enterpriseId) return sendTypedError(res, 404, 'enterprise_not_found');
    return res.status(202).json(await requestCompanyQuestionSuggestions(enterpriseId, req.user!.id));
  } catch (error) { return sendFailure(res, error); }
}

export async function getCompanyQuestionSuggestionsController(req: Request, res: Response) {
  res.setHeader('Cache-Control', 'private, no-store');
  const jobId = String(req.params.id ?? '');
  if (!z.uuid().safeParse(jobId).success) return sendTypedError(res, 404, 'ia_job_not_found');
  try {
    const enterpriseId = req.enterpriseId ?? await resolveEnterpriseIdByUser(req.user!.id);
    if (!enterpriseId) return sendTypedError(res, 404, 'enterprise_not_found');
    const job = await getCompanyQuestionSuggestions(enterpriseId, jobId);
    if (!job) return sendTypedError(res, 404, 'ia_job_not_found');
    return res.json(job);
  } catch (error) { return sendFailure(res, error); }
}
