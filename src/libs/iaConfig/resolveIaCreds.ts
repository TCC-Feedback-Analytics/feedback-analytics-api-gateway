import type { IaCreds } from '../../providers/iaAnalyze.provider.js';
import { getIaConfigByEnterprise } from '../../repositories/iaConfig.repository.js';
import { decryptSecret } from '../../utils/crypto.js';

/**
 * Config própria obrigatória? Quando `REQUIRE_USER_IA_KEY=true`, empresas sem
 * chave configurada NÃO usam o fallback global (a análise falha pedindo a chave).
 * Default false → transição suave (quem não configurou cai no fallback).
 */
export function requireUserIaKey(): boolean {
  return String(process.env.REQUIRE_USER_IA_KEY ?? '').trim() === 'true';
}

/**
 * Resolve as credenciais de IA da empresa, decifrando a chave (etapa 04 — BYO-key).
 * `null` = empresa sem config → o chamador decide entre o fallback global (chave
 * do env do ia-analyze) ou exigir (ver `requireUserIaKey`).
 */
export async function resolveIaCredsForEnterprise(enterpriseId: string): Promise<IaCreds | null> {
  const config = await getIaConfigByEnterprise(enterpriseId);
  if (!config?.apiKeyCiphertext || !config.apiKeyIv || !config.apiKeyAuthTag) {
    return null;
  }

  const apiKey = decryptSecret({
    ciphertext: config.apiKeyCiphertext,
    iv: config.apiKeyIv,
    authTag: config.apiKeyAuthTag,
  });

  return { provider: config.provider, apiKey, model: config.model ?? undefined };
}
