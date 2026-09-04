import { IaAnalyzeServiceError } from './errors.js';

/** Não confia em HTTP 200: a cobertura deve corresponder exatamente ao lote enviado. */
export function assertCompleteAnalyses(analyses: unknown, expectedIds: Set<string>): void {
  if (!Array.isArray(analyses)) {
    throw new IaAnalyzeServiceError('Invalid analysis response', 502, 'invalid_ai_response_schema');
  }
  const seen = new Set<string>();
  for (const item of analyses) {
    if (!item || typeof item !== 'object' || typeof item.feedback_id !== 'string' ||
        !expectedIds.has(item.feedback_id) || seen.has(item.feedback_id) ||
        !['positive', 'negative', 'neutral'].includes(item.sentiment)) {
      throw new IaAnalyzeServiceError('Invalid analysis item', 502, 'invalid_ai_response_schema');
    }
    seen.add(item.feedback_id);
  }
  if (seen.size !== expectedIds.size) {
    throw new IaAnalyzeServiceError('Missing feedback analyses', 502, 'incomplete_ai_response');
  }
}
