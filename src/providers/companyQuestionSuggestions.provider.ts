import type { CompanyQuestionSuggestionsRemoteRequest, CompanyQuestionSuggestionsRemoteResponse } from '@feedback/lib-shared/interfaces/contracts/ia-analyze/company-question-suggestions.contract';
import type { IaCreds } from './iaAnalyze.provider.js';
import { resolvePrimaryBaseUrl } from '../libs/iaAnalyze/resolvePrimaryBaseUrl.js';
import { readRemoteTimeoutMs, readRemoteToken } from '../libs/iaAnalyze/readEnvs.js';
import { IaAnalyzeServiceError } from '../libs/iaAnalyze/errors.js';
import { parseCompanyQuestionResponse } from '../libs/iaAnalyze/companyQuestions.js';

const REMOTE_ERRORS = new Set(['ia_provider_auth_error', 'ia_provider_credits_exhausted',
  'ia_provider_rate_limited', 'ia_provider_unavailable', 'ia_provider_error',
  'failed_ia_request', 'invalid_ai_response', 'invalid_ai_response_schema',
  'invalid_ai_response_language', 'truncated_ai_response', 'ai_response_refused']);

export async function runCompanyQuestionSuggestions(
  body: CompanyQuestionSuggestionsRemoteRequest, creds: IaCreds,
): Promise<CompanyQuestionSuggestionsRemoteResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(readRemoteTimeoutMs(), 90_000));
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json', 'x-llm-provider': creds.provider,
      'x-llm-api-key': creds.apiKey, 'x-llm-model': creds.model ?? '',
    };
    const token = readRemoteToken();
    if (token) headers['x-ia-analyze-token'] = token;
    const response = await fetch(`${resolvePrimaryBaseUrl()}/internal/ia-analyze/generate-company-questions`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (controller.signal.aborted) throw new Error('timeout');
    if (!response.ok) {
      const rawCode = payload && typeof payload === 'object' && 'error' in payload ? payload.error : null;
      const code = typeof rawCode === 'string' && REMOTE_ERRORS.has(rawCode) ? rawCode : 'question_generation_service_unavailable';
      throw new IaAnalyzeServiceError(code, 502, code);
    }
    return parseCompanyQuestionResponse(payload);
  } catch (error) {
    if (error instanceof IaAnalyzeServiceError) throw error;
    throw new IaAnalyzeServiceError('failed_remote_ia_analyze_request', 502, 'failed_remote_ia_analyze_request');
  } finally {
    clearTimeout(timer);
  }
}
