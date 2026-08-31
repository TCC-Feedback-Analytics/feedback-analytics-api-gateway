import type { IaCreds } from '../../providers/iaAnalyze.provider.js';
import { getIaConfigByEnterprise } from '../../repositories/iaConfig.repository.js';
import { decryptSecret } from '../../utils/crypto.js';

/**
 * Config própria obrigatória? Por padrão, empresas sem chave configurada NÃO
 * usam fallback global (a análise falha pedindo a chave). O fallback só pode ser
 * reativado de forma explícita com `REQUIRE_USER_IA_KEY=false`.
 */
export function requireUserIaKey(): boolean {
  return String(process.env.REQUIRE_USER_IA_KEY ?? 'true').trim().toLowerCase() !== 'false';
}

/**
 * Resolve as credenciais de IA da empresa, decifrando a chave (etapa 04 — BYO-key).
 * `null` = empresa sem config → o chamador bloqueia a análise por padrão ou,
 * quando explicitamente habilitado, usa o fallback global legado.
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
