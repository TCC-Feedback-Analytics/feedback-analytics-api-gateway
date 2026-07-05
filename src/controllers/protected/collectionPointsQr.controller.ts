import type { Request, Response } from 'express';
import {
  API_ERROR_COLLECTION_POINT_ERROR,
  API_ERROR_ENTERPRISE_NOT_FOUND,
  API_ERROR_INVALID_PAYLOAD,
  API_ERROR_UNABLE_TO_ACTIVATE_QR,
  API_ERROR_UNABLE_TO_CREATE_QR_CP,
  API_ERROR_UNABLE_TO_DISABLE_QR,
  API_ERROR_UPDATE_FAILED,
} from '../../config/errors.js';
import { sendTypedError } from '../../utils/sendTypedError.js';
import { resolveEnterpriseIdByUser } from '../../repositories/enterprise.repository.js';
import {
  QrPointWriteError,
  activateOrCreateCatalogQr,
  activateOrCreateCompanyQr,
  deactivateCatalogQr,
  deactivateCompanyQr,
  findActiveCompanyQrPoint,
  findQrPointsForCatalogItems,
  getCatalogItemForEnterprise,
  getCatalogQuestionsSnapshot,
  listActiveCatalogItems,
  saveCatalogQuestions,
  type CatalogKind,
  type NormalizedCatalogQuestion,
  type NormalizedCatalogSubquestion,
  type QuestionOrder,
  type SubquestionOrder,
} from '../../repositories/collectionPointsQr.repository.js';
import type { CatalogQuestionInput } from '../../types/catalogQuestion.types.js';

const TOTAL_ITEM_QUESTIONS = 3;
const TOTAL_SUBQUESTIONS_PER_QUESTION = 3;
const MIN_QUESTION_LENGTH = 20;
const MAX_QUESTION_LENGTH = 150;

function getCatalogKind(value: unknown): CatalogKind | null {
  if (value === 'PRODUCT' || value === 'SERVICE' || value === 'DEPARTMENT') {
    return value;
  }
  return null;
}

function normalizeQuestionOrder(value: unknown, fallback: number): QuestionOrder {
  const numericValue = Number(value);
  if (Number.isInteger(numericValue) && numericValue >= 1 && numericValue <= TOTAL_ITEM_QUESTIONS) {
    return numericValue as QuestionOrder;
  }
  return fallback as QuestionOrder;
}

function normalizeSubquestionOrder(value: unknown, fallback: number): SubquestionOrder {
  const numericValue = Number(value);
  if (Number.isInteger(numericValue) && numericValue >= 1 && numericValue <= TOTAL_SUBQUESTIONS_PER_QUESTION) {
    return numericValue as SubquestionOrder;
  }
  return fallback as SubquestionOrder;
}

function hasValidQuestionLength(value: string) {
  return value.length >= MIN_QUESTION_LENGTH && value.length <= MAX_QUESTION_LENGTH;
}

/**
 * Empresa do usuário: `req.enterpriseId` (Better Auth) ou resolve por auth_user_id
 * (supabase). A role do Drizzle ignora a RLS → o escopo por empresa é feito aqui.
 */
async function resolveEnterpriseId(req: Request): Promise<string | null> {
  if (req.enterpriseId) return req.enterpriseId;
  const userId = req.user?.id;
  return userId ? resolveEnterpriseIdByUser(userId) : null;
}

export async function getQrStatusController(req: Request, res: Response) {
  const enterpriseId = await resolveEnterpriseId(req);
  if (!enterpriseId) return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND, { active: false });

  try {
    const cp = await findActiveCompanyQrPoint(enterpriseId);
    return res.json({ active: !!cp, id: cp?.id ?? null });
  } catch (err) {
    console.error('Erro ao buscar status do QR:', err);
    return sendTypedError(res, 500, API_ERROR_COLLECTION_POINT_ERROR, { active: false });
  }
}

export async function enableQrController(req: Request, res: Response) {
  const enterpriseId = await resolveEnterpriseId(req);
  if (!enterpriseId) return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);

  try {
    const { id } = await activateOrCreateCompanyQr(enterpriseId);
    return res.json({ id, active: true });
  } catch (err) {
    if (err instanceof QrPointWriteError) {
      return sendTypedError(
        res,
        500,
        err.reason === 'create' ? API_ERROR_UNABLE_TO_CREATE_QR_CP : API_ERROR_UNABLE_TO_ACTIVATE_QR,
      );
    }
    throw err;
  }
}

export async function disableQrController(req: Request, res: Response) {
  const enterpriseId = await resolveEnterpriseId(req);
  if (!enterpriseId) return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);

  try {
    await deactivateCompanyQr(enterpriseId);
    return res.json({ active: false });
  } catch (err) {
    console.error('Erro ao desativar QR:', err);
    return sendTypedError(res, 500, API_ERROR_UNABLE_TO_DISABLE_QR);
  }
}

export async function getQrCatalogController(req: Request, res: Response) {
  const kind = getCatalogKind(req.query.kind);
  if (!kind) return sendTypedError(res, 400, API_ERROR_COLLECTION_POINT_ERROR);

  const enterpriseId = await resolveEnterpriseId(req);
  if (!enterpriseId) return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);

  try {
    const items = await listActiveCatalogItems(enterpriseId, kind);
    if (items.length === 0) return res.json({ items: [] });

    const itemIds = items.map((item) => item.id);
    const points = await findQrPointsForCatalogItems(enterpriseId, itemIds);

    const pointByCatalog = new Map<string, { id: string; status: string }>();
    for (const point of points) {
      if (!point.catalogItemId || pointByCatalog.has(point.catalogItemId)) continue;
      pointByCatalog.set(point.catalogItemId, { id: point.id, status: point.status });
    }

    const snapshot = await getCatalogQuestionsSnapshot({ enterpriseId, kind, catalogItemIds: itemIds });

    const responseItems = items.map((item) => {
      const point = pointByCatalog.get(item.id);
      return {
        catalog_item_id: item.id,
        name: item.name,
        description: item.description,
        kind: item.kind,
        active: point?.status === 'ACTIVE',
        collection_point_id: point?.id ?? null,
        questions: snapshot.get(item.id) ?? [],
      };
    });

    return res.json({ items: responseItems });
  } catch (err) {
    console.error('Erro ao buscar catálogo QR:', err);
    return sendTypedError(res, 500, API_ERROR_COLLECTION_POINT_ERROR);
  }
}

export async function upsertCatalogQuestionsController(req: Request, res: Response) {
  const catalogItemId = String(req.body?.catalog_item_id ?? '').trim();
  if (!catalogItemId) {
    return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD, { reason: 'catalog_item_id_missing' });
  }

  const rawQuestions = Array.isArray(req.body?.questions)
    ? (req.body.questions as CatalogQuestionInput[])
    : null;

  if (!rawQuestions || rawQuestions.length !== TOTAL_ITEM_QUESTIONS) {
    return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD, { reason: 'questions_must_have_3_slots' });
  }

  const enterpriseId = await resolveEnterpriseId(req);
  if (!enterpriseId) return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);

  const catalogItem = await getCatalogItemForEnterprise(enterpriseId, catalogItemId);
  if (!catalogItem || catalogItem.status !== 'ACTIVE') {
    return sendTypedError(res, 404, API_ERROR_COLLECTION_POINT_ERROR);
  }

  const catalogKind = getCatalogKind(catalogItem.kind);
  if (!catalogKind) {
    return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD, { reason: 'invalid_catalog_kind' });
  }

  const questionByOrder = new Map<QuestionOrder, NormalizedCatalogQuestion>();

  for (let index = 0; index < rawQuestions.length; index += 1) {
    const rawQuestion = rawQuestions[index];
    if (!rawQuestion || typeof rawQuestion !== 'object') {
      return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD, { reason: 'question_not_object' });
    }

    const questionOrder = normalizeQuestionOrder(rawQuestion.question_order, index + 1);
    if (questionByOrder.has(questionOrder)) {
      return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD, { reason: 'duplicate_question_order' });
    }

    const questionText = String(rawQuestion.question_text ?? '').trim();
    const questionIsActive = rawQuestion.is_active === true;

    if (questionText.length > 0 && !hasValidQuestionLength(questionText)) {
      return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD, {
        reason: 'question_length_invalid',
        question_order: questionOrder,
      });
    }
    if (questionIsActive && questionText.length === 0) {
      return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD, {
        reason: 'active_question_without_text',
        question_order: questionOrder,
      });
    }

    const rawSubquestions = Array.isArray(rawQuestion.subquestions)
      ? rawQuestion.subquestions.slice(0, TOTAL_SUBQUESTIONS_PER_QUESTION)
      : [];

    const subquestionsByOrder = new Map<SubquestionOrder, NormalizedCatalogSubquestion>();

    for (let subIndex = 0; subIndex < rawSubquestions.length; subIndex += 1) {
      const rawSubquestion = rawSubquestions[subIndex];
      if (!rawSubquestion || typeof rawSubquestion !== 'object') {
        return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD, { reason: 'subquestion_not_object' });
      }

      const subquestionOrder = normalizeSubquestionOrder(rawSubquestion.subquestion_order, subIndex + 1);
      if (subquestionsByOrder.has(subquestionOrder)) {
        return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD, { reason: 'duplicate_subquestion_order' });
      }

      const subquestionText = String(rawSubquestion.subquestion_text ?? '').trim();
      const subquestionIsActive = rawSubquestion.is_active === true;

      if (subquestionText.length > 0 && !hasValidQuestionLength(subquestionText)) {
        return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD, {
          reason: 'subquestion_length_invalid',
          question_order: questionOrder,
          subquestion_order: subquestionOrder,
        });
      }
      if (subquestionIsActive && subquestionText.length === 0) {
        return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD, {
          reason: 'active_subquestion_without_text',
          question_order: questionOrder,
          subquestion_order: subquestionOrder,
        });
      }

      subquestionsByOrder.set(subquestionOrder, {
        subquestion_order: subquestionOrder,
        subquestion_text: subquestionText,
        is_active: subquestionIsActive,
      });
    }

    questionByOrder.set(questionOrder, {
      question_order: questionOrder,
      question_text: questionText,
      is_active: questionIsActive,
      subquestionsByOrder,
    });
  }

  const orderedQuestions = ([1, 2, 3] as QuestionOrder[])
    .map((order) => questionByOrder.get(order))
    .filter((question): question is NormalizedCatalogQuestion => Boolean(question));

  if (orderedQuestions.length !== TOTAL_ITEM_QUESTIONS) {
    return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD, { reason: 'ordered_questions_not_3' });
  }

  // Contagem variável (1–3 slots): slot sem texto vira soft-delete; com texto,
  // persistido como ATIVO. Tudo numa transação (rollback em qualquer falha).
  try {
    await saveCatalogQuestions({ enterpriseId, kind: catalogKind, catalogItemId: catalogItem.id, questions: orderedQuestions });
    const snapshot = await getCatalogQuestionsSnapshot({ enterpriseId, kind: catalogKind, catalogItemIds: [catalogItem.id] });
    return res.json({
      catalog_item_id: catalogItem.id,
      questions: snapshot.get(catalogItem.id) ?? [],
    });
  } catch (err) {
    console.error('Erro ao salvar perguntas do item de catálogo:', err);
    return sendTypedError(res, 500, API_ERROR_UPDATE_FAILED);
  }
}

export async function enableCatalogQrController(req: Request, res: Response) {
  const catalogItemId = String(req.body?.catalog_item_id ?? '').trim();
  if (!catalogItemId) return sendTypedError(res, 400, API_ERROR_COLLECTION_POINT_ERROR);

  const enterpriseId = await resolveEnterpriseId(req);
  if (!enterpriseId) return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);

  const catalogItem = await getCatalogItemForEnterprise(enterpriseId, catalogItemId);
  if (!catalogItem || catalogItem.status !== 'ACTIVE') {
    return sendTypedError(res, 404, API_ERROR_COLLECTION_POINT_ERROR);
  }

  try {
    const { id } = await activateOrCreateCatalogQr(enterpriseId, { id: catalogItem.id, name: catalogItem.name });
    return res.json({ catalog_item_id: catalogItem.id, collection_point_id: id, active: true });
  } catch (err) {
    if (err instanceof QrPointWriteError) {
      return sendTypedError(
        res,
        500,
        err.reason === 'create' ? API_ERROR_UNABLE_TO_CREATE_QR_CP : API_ERROR_UNABLE_TO_ACTIVATE_QR,
      );
    }
    throw err;
  }
}

export async function disableCatalogQrController(req: Request, res: Response) {
  const catalogItemId = String(req.body?.catalog_item_id ?? '').trim();
  if (!catalogItemId) return sendTypedError(res, 400, API_ERROR_COLLECTION_POINT_ERROR);

  const enterpriseId = await resolveEnterpriseId(req);
  if (!enterpriseId) return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);

  try {
    await deactivateCatalogQr(enterpriseId, catalogItemId);
    return res.json({ catalog_item_id: catalogItemId, active: false });
  } catch (err) {
    console.error('Erro ao desativar QR do item de catálogo:', err);
    return sendTypedError(res, 500, API_ERROR_UNABLE_TO_DISABLE_QR);
  }
}
