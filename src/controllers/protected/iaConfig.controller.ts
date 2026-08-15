import type { Request, Response } from 'express';
import { z } from 'zod';
import { sendTypedError } from '../../utils/sendTypedError.js';
import {
  API_ERROR_ENTERPRISE_NOT_FOUND,
  API_ERROR_INVALID_PAYLOAD,
  API_ERROR_INTERNAL_SERVER_ERROR,
  API_ERROR_IA_CONFIG_INVALID_KEY,
} from '../../config/errors.js';
import { resolveEnterpriseIdByUser } from '../../repositories/enterprise.repository.js';
import {
  deleteIaConfig,
  getIaConfigByEnterprise,
  upsertIaConfig,
} from '../../repositories/iaConfig.repository.js';
import { encryptSecret } from '../../utils/crypto.js';
import { validateOpenRouterKey } from '../../libs/iaConfig/validateOpenRouterKey.js';

/** Empresa do usuário autenticado (req.enterpriseId do requireAuth; fallback pelo user). */
async function resolveEnterpriseId(req: Request): Promise<string | null> {
  if (req.enterpriseId) return req.enterpriseId;
  const userId = req.user?.id;
  return userId ? resolveEnterpriseIdByUser(userId) : null;
}

const updateSchema = z.object({
  provider: z.enum(['gemini', 'openrouter']).default('openrouter'),
  model: z.string().trim().max(120).optional(),
  apiKey: z.string().trim().min(1),
});

/**
 * Estado da config de IA da empresa. **Nunca** devolve a chave — só se existe,
 * o provedor, o modelo e o "hint" (últimos 4 caracteres) para a UI confirmar.
 */
export async function getIaConfigController(req: Request, res: Response) {
  const enterpriseId = await resolveEnterpriseId(req);
  if (!enterpriseId) return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);

  const config = await getIaConfigByEnterprise(enterpriseId);
  if (!config) {
    return res.json({ hasKey: false, provider: null, model: null, keyHint: null });
  }

  return res.json({
    hasKey: Boolean(config.apiKeyCiphertext),
    provider: config.provider,
    model: config.model,
    keyHint: config.keyHint,
  });
}

/**
 * Salva/atualiza a config: valida a chave no provedor (OpenRouter → /auth/key),
 * cifra (AES-256-GCM) e faz upsert. Responde sem a chave (só hasKey/provider/model/keyHint).
 */
export async function putIaConfigController(req: Request, res: Response) {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD);

  const enterpriseId = await resolveEnterpriseId(req);
  if (!enterpriseId) return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);

  const { provider, model, apiKey } = parsed.data;

  // Feedback imediato: valida a chave antes de salvar (OpenRouter tem /auth/key).
  if (provider === 'openrouter') {
    const valid = await validateOpenRouterKey(apiKey);
    if (!valid) return sendTypedError(res, 400, API_ERROR_IA_CONFIG_INVALID_KEY);
  }

  try {
    const encrypted = encryptSecret(apiKey);
    const keyHint = apiKey.slice(-4);

    await upsertIaConfig({
      enterpriseId,
      provider,
      model: model ?? null,
      apiKeyCiphertext: encrypted.ciphertext,
      apiKeyIv: encrypted.iv,
      apiKeyAuthTag: encrypted.authTag,
      keyHint,
    });

    return res.json({ hasKey: true, provider, model: model ?? null, keyHint });
  } catch (error) {
    // Não logar a chave; o erro aqui é de cifra (env ausente) ou de banco.
    console.error('[ia-config] falha ao salvar config de IA:', error);
    return sendTypedError(res, 500, API_ERROR_INTERNAL_SERVER_ERROR);
  }
}

/** Remove a config de IA da empresa (volta ao fallback global). */
export async function deleteIaConfigController(req: Request, res: Response) {
  const enterpriseId = await resolveEnterpriseId(req);
  if (!enterpriseId) return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);

  await deleteIaConfig(enterpriseId);
  return res.json({ hasKey: false, provider: null, model: null, keyHint: null });
}
