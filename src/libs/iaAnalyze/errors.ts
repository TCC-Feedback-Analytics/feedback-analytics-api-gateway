/**
 * Erro customizado para falhas no serviço de análise IA.
 *
 * Permite informar status HTTP e código de erro além da mensagem,
 * facilitando o tratamento padronizado de erros em toda a aplicação.
 *
 * Usado para diferenciar falhas do serviço IA de outros erros genéricos.
 */
export class IaAnalyzeServiceError extends Error {
  public statusCode: number;

  public code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Códigos de erro do ia-analyze que o gateway repassa como vieram, nas rotas de
 * sugestão de perguntas e de diagnóstico. Qualquer outro vira o "indisponível"
 * da rota. Lista única para as duas rotas não divergirem.
 */
export const REMOTE_IA_ERROR_CODES: ReadonlySet<string> = new Set([
  'ia_provider_auth_error', 'ia_provider_credits_exhausted', 'ia_provider_rate_limited',
  'ia_provider_unavailable', 'ia_provider_error', 'failed_ia_request', 'invalid_ai_response',
  'invalid_ai_response_schema', 'invalid_ai_response_language', 'truncated_ai_response',
  'ai_response_refused', 'empty_ai_response', 'invalid_provider_response', 'ia_config_required',
]);

/** Headers do LLM para o ia-analyze; sem modelo, o header não vai (vazio a IA recusa). */
export function buildLlmHeaders(creds: { provider: string; apiKey: string; model?: string | null }): Record<string, string> {
  return {
    'x-llm-provider': creds.provider,
    'x-llm-api-key': creds.apiKey,
    ...(creds.model ? { 'x-llm-model': creds.model } : {}),
  };
}
