import {
  API_ERROR_IA_CONFIG_CHANGED,
  API_ERROR_IA_CONFIG_REQUIRED,
  API_ERROR_IA_MODEL_UNAVAILABLE,
  API_ERROR_IA_MODELS_UNAVAILABLE,
} from '../config/errors.js';
import {
  deleteIaConfig,
  getIaConfigByEnterprise,
  updateIaModel,
  upsertIaConfig,
  type IaConfigRow,
} from '../repositories/iaConfig.repository.js';
import { decryptSecret, encryptSecret } from '../utils/crypto.js';
import { IaConfigError } from '../libs/iaConfig/iaConfigError.js';
import { DEFAULT_IA_MODEL, openRouterModels, type IaModelsCatalog } from '../libs/iaConfig/openRouterModels.js';

function readStoredKey(config: IaConfigRow | null): string {
  if (!config?.apiKeyCiphertext || config.provider !== 'openrouter') {
    throw new IaConfigError(409, API_ERROR_IA_CONFIG_REQUIRED);
  }
  if (!config.apiKeyIv || !config.apiKeyAuthTag) throw new Error('Incomplete IA credentials');
  return decryptSecret({
    ciphertext: config.apiKeyCiphertext,
    iv: config.apiKeyIv,
    authTag: config.apiKeyAuthTag,
  });
}

function assertModelAvailable(catalog: IaModelsCatalog, model: string): void {
  if (catalog.stale) throw new IaConfigError(503, API_ERROR_IA_MODELS_UNAVAILABLE);
  if (!catalog.models.some((candidate) => candidate.id === model)) {
    throw new IaConfigError(400, API_ERROR_IA_MODEL_UNAVAILABLE);
  }
}

export async function getIaModelsForEnterprise(enterpriseId: string) {
  const config = await getIaConfigByEnterprise(enterpriseId);
  const hasKey = Boolean(config?.apiKeyCiphertext);
  const catalog = await openRouterModels.get(hasKey
    ? { kind: 'user', enterpriseId, apiKey: readStoredKey(config) }
    : { kind: 'public' }, { allowStale: true });
  const currentModel = hasKey ? config?.model || DEFAULT_IA_MODEL : null;
  return {
    ...catalog,
    currentModel,
    currentModelAvailable: currentModel === null ? null : catalog.models.some((model) => model.id === currentModel),
  };
}

export async function saveIaConfigForEnterprise(enterpriseId: string, apiKey: string, model: string) {
  // /models/user valida a credencial E as restrições da conta, sem geração paga.
  const catalog = await openRouterModels.get({ kind: 'user', enterpriseId, apiKey }, { forceRefresh: true });
  assertModelAvailable(catalog, model);
  const encrypted = encryptSecret(apiKey);
  const keyHint = apiKey.slice(-4);
  await upsertIaConfig({
    enterpriseId,
    provider: 'openrouter',
    model,
    apiKeyCiphertext: encrypted.ciphertext,
    apiKeyIv: encrypted.iv,
    apiKeyAuthTag: encrypted.authTag,
    keyHint,
  });
  openRouterModels.invalidateEnterprise(enterpriseId);
  return { hasKey: true, provider: 'openrouter', model, keyHint };
}

export async function updateIaModelForEnterprise(enterpriseId: string, model: string) {
  const config = await getIaConfigByEnterprise(enterpriseId);
  const apiKey = readStoredKey(config);
  const catalog = await openRouterModels.get({ kind: 'user', enterpriseId, apiKey }, { forceRefresh: true });
  assertModelAvailable(catalog, model);
  const updated = await updateIaModel(enterpriseId, config!, model);
  if (!updated) throw new IaConfigError(409, API_ERROR_IA_CONFIG_CHANGED);
  return updated;
}

export async function removeIaConfigForEnterprise(enterpriseId: string): Promise<void> {
  await deleteIaConfig(enterpriseId);
  openRouterModels.invalidateEnterprise(enterpriseId);
}
