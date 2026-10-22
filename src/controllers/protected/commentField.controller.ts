import type { Request, Response } from 'express';
import { commentFieldSettingsSchema } from '@feedback/lib-shared/schemas/public/commentField';
import {
  API_ERROR_ENTERPRISE_NOT_FOUND,
  API_ERROR_INTERNAL_SERVER_ERROR,
  API_ERROR_INVALID_PAYLOAD,
} from '../../config/errors.js';
import { sendTypedError } from '../../utils/sendTypedError.js';
import { parseScopeType } from '../../libs/iaAnalyze/parse.js';
import { resolveEnterpriseIdByUser } from '../../repositories/enterprise.repository.js';
import { fetchCatalogItemsByIds } from '../../repositories/feedbackList.repository.js';
import { fetchCommentField, upsertCommentField } from '../../repositories/commentField.repository.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const API_ERROR_CATALOG_ITEM_NOT_FOUND = 'catalog_item_not_found' as const;

async function enterpriseOf(req: Request): Promise<string | null> {
  return req.enterpriseId ?? (await resolveEnterpriseIdByUser(req.user!.id));
}

/** O item precisa ser da empresa e do tipo do escopo. */
async function itemBelongs(enterpriseId: string, scopeType: string, catalogItemId: string | null): Promise<boolean> {
  if (scopeType === 'COMPANY') return catalogItemId === null;
  if (!catalogItemId) return false;
  const [item] = await fetchCatalogItemsByIds(enterpriseId, [catalogItemId]);
  return Boolean(item && item.kind === scopeType);
}

/** Campo de comentário do formulário de um escopo (empresa ou item). */
export async function getCommentFieldController(req: Request, res: Response) {
  res.setHeader('Cache-Control', 'private, no-store');
  const scopeType = parseScopeType(req.query.scope_type ?? 'COMPANY');
  const rawItem = String(req.query.catalog_item_id ?? '').trim();
  const catalogItemId = rawItem ? rawItem : null;
  if (!scopeType || (catalogItemId && !UUID_RE.test(catalogItemId))) {
    return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD);
  }

  try {
    const enterpriseId = await enterpriseOf(req);
    if (!enterpriseId) return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);
    if (!(await itemBelongs(enterpriseId, scopeType, catalogItemId))) {
      return sendTypedError(res, 404, API_ERROR_CATALOG_ITEM_NOT_FOUND);
    }
    return res.json(await fetchCommentField({ enterpriseId, scopeType, catalogItemId }));
  } catch (error) {
    console.error('[comment-field] leitura:', error);
    return sendTypedError(res, 500, API_ERROR_INTERNAL_SERVER_ERROR);
  }
}

/** Salva o campo de comentário: convite padrão, pergunta própria ou oculto. */
export async function putCommentFieldController(req: Request, res: Response) {
  res.setHeader('Cache-Control', 'private, no-store');
  const parsed = commentFieldSettingsSchema.safeParse(req.body ?? {});
  if (!parsed.success) return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD);
  const payload = parsed.data;

  try {
    const enterpriseId = await enterpriseOf(req);
    if (!enterpriseId) return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);
    if (!(await itemBelongs(enterpriseId, payload.scope_type, payload.catalog_item_id))) {
      return sendTypedError(res, 404, API_ERROR_CATALOG_ITEM_NOT_FOUND);
    }
    return res.json(await upsertCommentField(enterpriseId, payload));
  } catch (error) {
    console.error('[comment-field] salvar:', error);
    return sendTypedError(res, 500, API_ERROR_INTERNAL_SERVER_ERROR);
  }
}
