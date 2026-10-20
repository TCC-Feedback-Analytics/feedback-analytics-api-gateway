import type {
  ScopeDiagnosisRemoteRequest,
  ScopeDiagnosisResult,
} from '@feedback/lib-shared/interfaces/contracts/ia-analyze/scope-diagnosis.contract';
import type { IaCreds } from './iaAnalyze.provider.js';
import { resolvePrimaryBaseUrl } from '../libs/iaAnalyze/resolvePrimaryBaseUrl.js';
import { readRemoteTimeoutMs, readRemoteToken } from '../libs/iaAnalyze/readEnvs.js';
import { IaAnalyzeServiceError } from '../libs/iaAnalyze/errors.js';
import { parseScopeDiagnosisResponse } from '../libs/scopeDiagnosis.js';

const REMOTE_ERRORS = new Set(['ia_provider_auth_error', 'ia_provider_credits_exhausted',
  'ia_provider_rate_limited', 'ia_provider_unavailable', 'ia_provider_error',
  'failed_ia_request', 'invalid_ai_response', 'invalid_ai_response_schema',
  'invalid_ai_response_language', 'truncated_ai_response', 'ai_response_refused',
  'empty_ai_response', 'invalid_provider_response', 'ia_config_required']);

/** Uma chamada ao ia-analyze com o pacote do escopo e a chave da empresa (por header, fora do corpo e dos logs). */
export async function runScopeDiagnosis(body: ScopeDiagnosisRemoteRequest, creds: IaCreds): Promise<ScopeDiagnosisResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(readRemoteTimeoutMs(), 120_000));
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json', 'x-llm-provider': creds.provider,
      'x-llm-api-key': creds.apiKey, 'x-llm-model': creds.model ?? '',
    };
    const token = readRemoteToken();
    if (token) headers['x-ia-analyze-token'] = token;
    const response = await fetch(`${resolvePrimaryBaseUrl()}/internal/ia-analyze/diagnose-scope`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (controller.signal.aborted) throw new Error('timeout');
    if (!response.ok) {
      const rawCode = payload && typeof payload === 'object' && 'error' in payload ? payload.error : null;
      const code = typeof rawCode === 'string' && REMOTE_ERRORS.has(rawCode) ? rawCode : 'scope_diagnosis_service_unavailable';
      throw new IaAnalyzeServiceError(code, 502, code);
    }
    return parseScopeDiagnosisResponse(payload);
  } catch (error) {
    if (error instanceof IaAnalyzeServiceError) throw error;
    throw new IaAnalyzeServiceError('failed_remote_ia_analyze_request', 502, 'failed_remote_ia_analyze_request');
  } finally {
    clearTimeout(timer);
  }
}
