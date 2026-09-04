import type { Request, Response } from 'express';
import { z } from 'zod';
import { sendTypedError } from '../../utils/sendTypedError.js';
import {
  API_ERROR_ENTERPRISE_NOT_FOUND,
  API_ERROR_INVALID_PAYLOAD,
  API_ERROR_INTERNAL_SERVER_ERROR,
} from '../../config/errors.js';
import { resolveEnterpriseIdByUser } from '../../repositories/enterprise.repository.js';
import { getIaConfigByEnterprise } from '../../repositories/iaConfig.repository.js';
import {
  getIaModelsForEnterprise,
  removeIaConfigForEnterprise,
  saveIaConfigForEnterprise,
  updateIaModelForEnterprise,
} from '../../services/iaConfig.service.js';
import { IaConfigError } from '../../libs/iaConfig/iaConfigError.js';
import { DEFAULT_IA_MODEL } from '../../libs/iaConfig/openRouterModels.js';

/** Empresa do usuário autenticado (req.enterpriseId do requireAuth; fallback pelo user). */
async function resolveEnterpriseId(req: Request): Promise<string | null> {
  if (req.enterpriseId) return req.enterpriseId;
  const userId = req.user?.id;
  return userId ? resolveEnterpriseIdByUser(userId) : null;
}

const updateSchema = z.object({
  provider: z.literal('openrouter').default('openrouter'),
  model: z.string().trim().max(120).optional(),
  apiKey: z.string().trim().min(1),
});

const modelSchema = z.object({ model: z.string().trim().min(1).max(120) }).strict();

function handleIaConfigError(res: Response, error: unknown) {
  if (error instanceof IaConfigError) return sendTypedError(res, error.status, error.code);
  // Erros do banco/provedor podem carregar parâmetros, headers ou credenciais.
  console.error('[ia-config] falha interna na configuração de IA');
  return sendTypedError(res, 500, API_ERROR_INTERNAL_SERVER_ERROR);
}

/**
 * Estado da config de IA da empresa. **Nunca** devolve a chave — só se existe,
 * o provedor, o modelo e o "hint" (últimos 4 caracteres) para a UI confirmar.
 */
export async function getIaConfigController(req: Request, res: Response) {
  try {
    const enterpriseId = await resolveEnterpriseId(req);
    if (!enterpriseId) return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);

    const config = await getIaConfigByEnterprise(enterpriseId);
    return res.json({
      hasKey: Boolean(config?.apiKeyCiphertext),
      provider: config?.provider ?? null,
      model: config?.model ?? null,
      keyHint: config?.keyHint ?? null,
    });
  } catch (error) {
    return handleIaConfigError(res, error);
  }
}

/**
 * Valida chave e modelo em /models/user, cifra (AES-256-GCM) e faz upsert.
 * Responde sem a chave (só hasKey/provider/model/keyHint).
 */
export async function putIaConfigController(req: Request, res: Response) {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD);

  try {
    const enterpriseId = await resolveEnterpriseId(req);
    if (!enterpriseId) return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);
    const { apiKey, model } = parsed.data;
    return res.json(await saveIaConfigForEnterprise(enterpriseId, apiKey, model || DEFAULT_IA_MODEL));
  } catch (error) {
    return handleIaConfigError(res, error);
  }
}

/** Remove a config de IA da empresa (as análises ficam bloqueadas até nova configuração). */
export async function deleteIaConfigController(req: Request, res: Response) {
  try {
    const enterpriseId = await resolveEnterpriseId(req);
    if (!enterpriseId) return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);
    await removeIaConfigForEnterprise(enterpriseId);
    return res.json({ hasKey: false, provider: null, model: null, keyHint: null });
  } catch (error) {
    return handleIaConfigError(res, error);
  }
}

/** Catálogo público ou filtrado pela conta; a chave fica exclusivamente no servidor. */
export async function getIaModelsController(req: Request, res: Response) {
  try {
    const enterpriseId = await resolveEnterpriseId(req);
    if (!enterpriseId) return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);
    return res.json(await getIaModelsForEnterprise(enterpriseId));
  } catch (error) {
    return handleIaConfigError(res, error);
  }
}

/** Troca apenas o modelo, sem receber, regravar ou recriar credenciais. */
export async function patchIaModelController(req: Request, res: Response) {
  const parsed = modelSchema.safeParse(req.body);
  if (!parsed.success) return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD);
  try {
    const enterpriseId = await resolveEnterpriseId(req);
    if (!enterpriseId) return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);
    return res.json(await updateIaModelForEnterprise(enterpriseId, parsed.data.model));
  } catch (error) {
    return handleIaConfigError(res, error);
  }
}
