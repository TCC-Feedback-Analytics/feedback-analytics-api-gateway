/**
 * Repositório da config de IA por empresa (etapa 04 — BYO-key). Sempre escopado
 * por `enterprise_id` (a role do Drizzle ignora a RLS — ver tenantScope). A chave
 * fica cifrada; a decifra é responsabilidade da camada de serviço, não daqui.
 */
import { getDb } from '../db/client.js';
import { enterpriseIaConfig } from '../../drizzle/schema.js';
import { scopedByEnterprise } from '../db/tenantScope.js';

export type IaConfigRow = {
  enterpriseId: string;
  provider: string;
  model: string | null;
  apiKeyCiphertext: string | null;
  apiKeyIv: string | null;
  apiKeyAuthTag: string | null;
  keyHint: string | null;
};

export async function getIaConfigByEnterprise(enterpriseId: string): Promise<IaConfigRow | null> {
  const rows = await getDb()
    .select({
      enterpriseId: enterpriseIaConfig.enterpriseId,
      provider: enterpriseIaConfig.provider,
      model: enterpriseIaConfig.model,
      apiKeyCiphertext: enterpriseIaConfig.apiKeyCiphertext,
      apiKeyIv: enterpriseIaConfig.apiKeyIv,
      apiKeyAuthTag: enterpriseIaConfig.apiKeyAuthTag,
      keyHint: enterpriseIaConfig.keyHint,
    })
    .from(enterpriseIaConfig)
    .where(scopedByEnterprise(enterpriseIaConfig.enterpriseId, enterpriseId))
    .limit(1);

  return rows[0] ?? null;
}

export async function upsertIaConfig(params: {
  enterpriseId: string;
  provider: string;
  model: string | null;
  apiKeyCiphertext: string;
  apiKeyIv: string;
  apiKeyAuthTag: string;
  keyHint: string;
}): Promise<void> {
  await getDb()
    .insert(enterpriseIaConfig)
    .values({
      enterpriseId: params.enterpriseId,
      provider: params.provider,
      model: params.model,
      apiKeyCiphertext: params.apiKeyCiphertext,
      apiKeyIv: params.apiKeyIv,
      apiKeyAuthTag: params.apiKeyAuthTag,
      keyHint: params.keyHint,
    })
    .onConflictDoUpdate({
      target: enterpriseIaConfig.enterpriseId,
      set: {
        provider: params.provider,
        model: params.model,
        apiKeyCiphertext: params.apiKeyCiphertext,
        apiKeyIv: params.apiKeyIv,
        apiKeyAuthTag: params.apiKeyAuthTag,
        keyHint: params.keyHint,
      },
    });
}

export async function deleteIaConfig(enterpriseId: string): Promise<void> {
  await getDb()
    .delete(enterpriseIaConfig)
    .where(scopedByEnterprise(enterpriseIaConfig.enterpriseId, enterpriseId));
}
