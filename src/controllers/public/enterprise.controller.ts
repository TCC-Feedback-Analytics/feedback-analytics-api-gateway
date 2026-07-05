import type { Request, Response } from 'express';
import {
  API_ERROR_ENTERPRISE_ID_REQUIRED,
  API_ERROR_ENTERPRISE_NOT_FOUND,
  API_ERROR_INTERNAL_SERVER_ERROR,
} from '../../config/errors.js';
import { sendTypedError } from '../../utils/sendTypedError.js';
import { fetchActiveQuestionsForScope } from '../../repositories/publicQuestions.repository.js';
import {
  getPublicEnterpriseById,
  resolveQrCollectionPoint,
} from '../../repositories/publicEnterprise.repository.js';

function normalizeItemKind(kind: string | null): 'PRODUCT' | 'SERVICE' | 'DEPARTMENT' | null {
  return kind === 'PRODUCT' || kind === 'SERVICE' || kind === 'DEPARTMENT' ? kind : null;
}

export async function getPublicEnterpriseController(req: Request, res: Response) {
  const { id } = req.params;
  const collectionPointId = String(req.query.collection_point ?? '').trim();
  const catalogItemId = String(req.query.catalog_item ?? '').trim();

  if (!id) {
    return sendTypedError(res, 400, API_ERROR_ENTERPRISE_ID_REQUIRED);
  }

  try {
    const enterprise = await getPublicEnterpriseById(String(id));
    if (!enterprise) {
      return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);
    }

    let contextCollectionPointId: string | null = null;
    let contextCatalogItemId: string | null = null;
    let contextItemName: string | null = null;
    let contextItemKind: 'PRODUCT' | 'SERVICE' | 'DEPARTMENT' | null = null;

    if (collectionPointId || catalogItemId) {
      const cp = await resolveQrCollectionPoint({
        enterpriseId: enterprise.id,
        collectionPointId: collectionPointId || null,
        catalogItemId: catalogItemId || null,
      });

      if (cp) {
        contextCollectionPointId = cp.id;
        contextCatalogItemId = cp.catalogItemId;
        contextItemName = cp.catalogItemName;
        contextItemKind = normalizeItemKind(cp.catalogItemKind);
      }
    } else {
      // Escopo empresa: ponto de coleta QR "geral" (catalog_item_id IS NULL),
      // que é EXATAMENTE o destino que o submit exige.
      const companyCp = await resolveQrCollectionPoint({
        enterpriseId: enterprise.id,
        catalogItemId: null,
      });
      if (companyCp) contextCollectionPointId = companyCp.id;
    }

    const currentScope: 'COMPANY' | 'PRODUCT' | 'SERVICE' | 'DEPARTMENT' =
      contextItemKind ?? 'COMPANY';

    // Contagem variável por escopo, SEM fallback para Geral.
    const { data: questions, error: questionsError } = await fetchActiveQuestionsForScope({
      enterpriseId: enterprise.id,
      scopeType: currentScope,
      catalogItemId: contextCatalogItemId,
    });

    if (questionsError) {
      console.error('Erro ao buscar perguntas públicas de feedback:', questionsError);
    }

    return res.json({
      id: enterprise.id,
      name: enterprise.name || 'Empresa',
      collection_point_id: contextCollectionPointId,
      catalog_item_id: contextCatalogItemId,
      item_name: contextItemName,
      item_kind: contextItemKind,
      questions: questions ?? [],
    });
  } catch (err) {
    console.error('Erro ao buscar empresa:', err);
    return sendTypedError(res, 500, API_ERROR_INTERNAL_SERVER_ERROR);
  }
}
