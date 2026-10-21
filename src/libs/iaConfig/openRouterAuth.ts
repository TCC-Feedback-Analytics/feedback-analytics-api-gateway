/**
 * "Conectar com OpenRouter" (OAuth PKCE): a Web manda a pessoa para o
 * OpenRouter, que devolve um código; aqui o código vira a chave da conta dela.
 * A chave nunca passa pelo navegador: é trocada, validada e cifrada no servidor.
 * https://openrouter.ai/docs/use-cases/oauth-pkce
 */
import { z } from 'zod';
import { API_ERROR_OPENROUTER_CONNECT_FAILED } from '../../config/errors.js';
import { IaConfigError } from './iaConfigError.js';
import type { IaModelsCatalog } from './openRouterModels.js';
import { DEFAULT_IA_MODEL } from './openRouterModels.js';

const OPENROUTER_AUTH_KEYS_URL = 'https://openrouter.ai/api/v1/auth/keys';
const REQUEST_TIMEOUT_MS = 10_000;

/** Roteador do OpenRouter que só usa modelos gratuitos: o ponto de partida de quem conecta. */
export const FREE_ROUTER_MODEL = 'openrouter/free';

const responseSchema = z.object({ key: z.string().trim().min(10).max(500) });

/** Troca o código (com o verificador do PKCE) pela chave da conta OpenRouter. */
export async function exchangeOpenRouterCode(code: string, codeVerifier: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(OPENROUTER_AUTH_KEYS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: codeVerifier, code_challenge_method: 'S256' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new IaConfigError(503, API_ERROR_OPENROUTER_CONNECT_FAILED, true);
  }
  // Código vencido, já usado ou verificador errado: a pessoa conecta de novo.
  if (!response.ok) throw new IaConfigError(400, API_ERROR_OPENROUTER_CONNECT_FAILED);
  const parsed = responseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new IaConfigError(502, API_ERROR_OPENROUTER_CONNECT_FAILED, true);
  return parsed.data.key;
}

/**
 * Modelo de quem acabou de conectar: o escolhido (se a conta tem), senão o que
 * já estava salvo, senão o roteador gratuito, senão o primeiro gratuito.
 */
export function pickConnectModel(catalog: IaModelsCatalog, preferred: Array<string | null | undefined>): string {
  const available = new Set(catalog.models.map((model) => model.id));
  for (const id of preferred) if (id && available.has(id)) return id;
  if (available.has(FREE_ROUTER_MODEL)) return FREE_ROUTER_MODEL;
  return catalog.models.find((model) => model.id.endsWith(':free'))?.id ?? DEFAULT_IA_MODEL;
}
