import type { Request, Response } from 'express';
import { enterpriseUpdateSchema } from '@feedback/lib-shared/schemas/user/enterpriseUpdateSchema';
import {
  API_ERROR_COLLECTING_DATA_NOT_FOUND,
  API_ERROR_EMPTY_PAYLOAD,
  API_ERROR_ENTERPRISE_NOT_FOUND,
  API_ERROR_INVALID_PAYLOAD,
  API_ERROR_UPSERT_FAILED,
} from '../../config/errors.js';
import { sendTypedError } from '../../utils/sendTypedError.js';
import { resolveEnterpriseIdByUser } from '../../repositories/enterprise.repository.js';
import type { CatalogQuestionInput as CompanyFeedbackQuestionInput } from '../../types/catalogQuestion.types.js';
import {
  CollectingWriteError,
  getCatalogSnapshot,
  getCollectingDataByEnterprise,
  getCompanyQuestionsSnapshot,
  getEnterpriseByUser,
  saveCollectingDataPatch,
  saveCollectingDataUpsert,
  updateEnterpriseByUser,
  type CollectingWriteColumns,
  type NormalizedCatalogItem,
  type NormalizedCompanyQuestion,
  type NormalizedCompanySubquestion,
  type SyncPlan,
} from '../../repositories/collectingData.repository.js';

type CatalogItemInput = {
  id?: string;
  name: string;
  description?: string | null;
  sort_order?: number;
  status?: 'ACTIVE' | 'INACTIVE';
};

type CollectingDataPayload = {
  company_objective?: string | null;
  analytics_goal?: string | null;
  business_summary?: string | null;
  main_products_or_services?: string[] | null;
  uses_company_products?: boolean;
  uses_company_services?: boolean;
  uses_company_departments?: boolean;
  catalog_products?: CatalogItemInput[] | null;
  catalog_services?: CatalogItemInput[] | null;
  catalog_departments?: CatalogItemInput[] | null;
  company_feedback_questions?: CompanyFeedbackQuestionInput[] | null;
};

const DEFAULT_COMPANY_FEEDBACK_QUESTIONS: CompanyFeedbackQuestionInput[] = [
  { question_order: 1, question_text: 'Como foi sua experiência em relação ao atendimento?', is_active: true, subquestions: [] },
  { question_order: 2, question_text: 'O que você achou da qualidade do produto/serviço?', is_active: true, subquestions: [] },
  { question_order: 3, question_text: 'Como você avalia a relação entre o valor pago e a qualidade do produto/serviço?', is_active: true, subquestions: [] },
];

const MIN_QUESTION_LENGTH = 20;
const MAX_QUESTION_LENGTH = 150;

function hasValidQuestionLength(value: string) {
  return value.length >= MIN_QUESTION_LENGTH && value.length <= MAX_QUESTION_LENGTH;
}

function normalizeCatalogItems(items: CatalogItemInput[] | null | undefined): NormalizedCatalogItem[] {
  return (items ?? [])
    .map((item, index): NormalizedCatalogItem | null => {
      const name = String(item?.name ?? '').trim();
      if (!name) return null;
      return {
        ...(item?.id ? { id: item.id } : {}),
        name,
        description: item?.description?.trim() || null,
        sortOrder: typeof item?.sort_order === 'number' && Number.isFinite(item.sort_order) ? item.sort_order : index,
        status: item?.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
      };
    })
    .filter((item): item is NormalizedCatalogItem => item !== null);
}

function normalizeCompanyFeedbackQuestions(
  items: CompanyFeedbackQuestionInput[] | null | undefined,
): NormalizedCompanyQuestion[] | null {
  const source = Array.isArray(items) && items.length > 0 ? items.slice(0, 3) : DEFAULT_COMPANY_FEEDBACK_QUESTIONS;

  const questionByOrder = new Map<number, NormalizedCompanyQuestion>();

  for (let index = 0; index < source.length; index += 1) {
    const item = source[index];
    const questionOrderRaw = Number(item?.question_order);
    const questionOrder =
      Number.isInteger(questionOrderRaw) && questionOrderRaw >= 1 && questionOrderRaw <= 3
        ? (questionOrderRaw as 1 | 2 | 3)
        : ((index + 1) as 1 | 2 | 3);

    if (questionByOrder.has(questionOrder)) return null;

    const questionText = String(item?.question_text ?? '').trim();
    if (!hasValidQuestionLength(questionText)) return null;

    const rawSubquestions = Array.isArray(item?.subquestions) ? item.subquestions.slice(0, 3) : [];
    const subquestionsByOrder = new Map<1 | 2 | 3, NormalizedCompanySubquestion>();

    for (let subIndex = 0; subIndex < rawSubquestions.length; subIndex += 1) {
      const subquestion = rawSubquestions[subIndex];
      if (!subquestion || typeof subquestion !== 'object') return null;

      const subquestionOrderRaw = Number(subquestion.subquestion_order);
      const subquestionOrder =
        Number.isInteger(subquestionOrderRaw) && subquestionOrderRaw >= 1 && subquestionOrderRaw <= 3
          ? (subquestionOrderRaw as 1 | 2 | 3)
          : ((subIndex + 1) as 1 | 2 | 3);

      if (subquestionsByOrder.has(subquestionOrder)) return null;

      const subquestionText = String(subquestion.subquestion_text ?? '').trim();
      const subquestionIsActive = subquestion.is_active === true;

      if (!subquestionText) {
        if (subquestionIsActive) return null;
        continue;
      }

      if (!hasValidQuestionLength(subquestionText)) return null;

      subquestionsByOrder.set(subquestionOrder, {
        subquestion_order: subquestionOrder,
        subquestion_text: subquestionText,
        is_active: subquestionIsActive,
      });
    }

    questionByOrder.set(questionOrder, {
      question_order: questionOrder,
      question_text: questionText,
      is_active: item?.is_active === false ? false : true,
      subquestionsByOrder,
    });
  }

  const orderedQuestions = ([1, 2, 3] as const)
    .map((order) => questionByOrder.get(order))
    .filter((question): question is NormalizedCompanyQuestion => Boolean(question));

  if (orderedQuestions.length !== 3) return null;

  return orderedQuestions;
}

/**
 * Empresa do usuário autenticado. Em Better Auth vem de `req.enterpriseId` (já
 * resolvido no requireAuth); em modo supabase caímos no resolve por auth_user_id.
 */
async function resolveEnterpriseId(req: Request): Promise<string | null> {
  if (req.enterpriseId) return req.enterpriseId;
  const userId = req.user?.id;
  return userId ? resolveEnterpriseIdByUser(userId) : null;
}

export async function getEnterpriseController(req: Request, res: Response) {
  const user = req.user!;

  const enterprise = await getEnterpriseByUser(user.id);
  if (!enterprise) return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);

  return res.json({ enterprise, user: { id: user.id, email: user.email ?? null, phone: user.phone ?? null } });
}

export async function patchEnterpriseController(req: Request, res: Response) {
  const parsed = enterpriseUpdateSchema.safeParse(req.body);
  if (!parsed.success) return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD);

  const user = req.user!;

  const enterprise = await updateEnterpriseByUser(user.id, parsed.data);
  if (!enterprise) return sendTypedError(res, 401, API_ERROR_ENTERPRISE_NOT_FOUND);

  return res.json({ enterprise, user: { id: user.id, email: user.email ?? null, phone: user.phone ?? null } });
}

export async function getCollectingDataController(req: Request, res: Response) {
  const enterpriseId = await resolveEnterpriseId(req);
  if (!enterpriseId) return res.json({ collecting: null });

  let collecting;
  try {
    collecting = await getCollectingDataByEnterprise(enterpriseId);
  } catch (err) {
    console.error('Erro ao buscar dados de coleta:', err);
    return sendTypedError(res, 404, API_ERROR_COLLECTING_DATA_NOT_FOUND);
  }

  if (!collecting) return res.json({ collecting: null });

  const catalog = await getCatalogSnapshot(enterpriseId);
  const companyFeedbackQuestions = await getCompanyQuestionsSnapshot(enterpriseId);

  return res.json({ collecting: { ...collecting, ...catalog, company_feedback_questions: companyFeedbackQuestions } });
}

function buildCatalogSyncSteps(payload: CollectingDataPayload, mode: 'patch' | 'upsert'): SyncPlan['catalog'] {
  const hasProducts = 'catalog_products' in payload;
  const hasServices = 'catalog_services' in payload;
  const hasDepartments = 'catalog_departments' in payload;
  const disableProducts = payload.uses_company_products === false;
  const disableServices = payload.uses_company_services === false;
  const disableDepartments = payload.uses_company_departments === false;

  return [
    {
      kind: 'PRODUCT',
      run: mode === 'upsert' || hasProducts || disableProducts,
      items: normalizeCatalogItems(payload.catalog_products),
      disableAll: disableProducts,
    },
    {
      kind: 'SERVICE',
      run: mode === 'upsert' || hasServices || disableServices,
      items: normalizeCatalogItems(payload.catalog_services),
      disableAll: disableServices,
    },
    {
      kind: 'DEPARTMENT',
      run: mode === 'upsert' || hasDepartments || disableDepartments,
      items: normalizeCatalogItems(payload.catalog_departments),
      disableAll: disableDepartments,
    },
  ];
}

export async function patchCollectingDataController(req: Request, res: Response) {
  const enterpriseId = await resolveEnterpriseId(req);
  if (!enterpriseId) return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);

  const payload = (req.body ?? {}) as CollectingDataPayload;

  const update: CollectingWriteColumns = {};
  let touchedCollecting = false;
  if ('company_objective' in payload) { update.companyObjective = payload.company_objective ?? null; touchedCollecting = true; }
  if ('analytics_goal' in payload) { update.analyticsGoal = payload.analytics_goal ?? null; touchedCollecting = true; }
  if ('business_summary' in payload) { update.businessSummary = payload.business_summary ?? null; touchedCollecting = true; }
  if ('main_products_or_services' in payload) { update.mainProductsOrServices = payload.main_products_or_services ?? null; touchedCollecting = true; }
  if ('uses_company_products' in payload) {
    update.usesCompanyProducts = payload.uses_company_products ?? false;
    if (payload.uses_company_products === false) update.mainProductsOrServices = null;
    touchedCollecting = true;
  }
  if ('uses_company_services' in payload) { update.usesCompanyServices = payload.uses_company_services ?? false; touchedCollecting = true; }
  if ('uses_company_departments' in payload) { update.usesCompanyDepartments = payload.uses_company_departments ?? false; touchedCollecting = true; }

  const hasCompanyFeedbackQuestions = 'company_feedback_questions' in payload;
  const hasAnyCatalog = 'catalog_products' in payload || 'catalog_services' in payload || 'catalog_departments' in payload;

  if (!touchedCollecting && !hasAnyCatalog && !hasCompanyFeedbackQuestions) {
    return sendTypedError(res, 400, API_ERROR_EMPTY_PAYLOAD);
  }

  const insert: CollectingWriteColumns = {};
  if ('company_objective' in payload) insert.companyObjective = payload.company_objective ?? null;
  if ('analytics_goal' in payload) insert.analyticsGoal = payload.analytics_goal ?? null;
  if ('business_summary' in payload) insert.businessSummary = payload.business_summary ?? null;
  if ('main_products_or_services' in payload) insert.mainProductsOrServices = payload.uses_company_products === false ? null : payload.main_products_or_services ?? null;
  if ('uses_company_products' in payload) insert.usesCompanyProducts = payload.uses_company_products ?? false;
  if ('uses_company_services' in payload) insert.usesCompanyServices = payload.uses_company_services ?? false;
  if ('uses_company_departments' in payload) insert.usesCompanyDepartments = payload.uses_company_departments ?? false;

  const plan: SyncPlan = { catalog: buildCatalogSyncSteps(payload, 'patch'), questions: null };

  if (hasCompanyFeedbackQuestions) {
    const normalizedQuestions = normalizeCompanyFeedbackQuestions(payload.company_feedback_questions);
    if (!normalizedQuestions) return sendTypedError(res, 400, API_ERROR_UPSERT_FAILED);
    plan.questions = normalizedQuestions;
  }

  try {
    const collecting = await saveCollectingDataPatch({ enterpriseId, update, insert, plan });
    const catalog = await getCatalogSnapshot(enterpriseId);
    const companyFeedbackQuestions = await getCompanyQuestionsSnapshot(enterpriseId);
    return res.json({ collecting: { ...collecting, ...catalog, company_feedback_questions: companyFeedbackQuestions } });
  } catch (err) {
    if (err instanceof CollectingWriteError) return sendTypedError(res, 400, API_ERROR_UPSERT_FAILED);
    throw err;
  }
}

export async function upsertCollectingDataController(req: Request, res: Response) {
  const enterpriseId = await resolveEnterpriseId(req);
  if (!enterpriseId) return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);

  const payload = (req.body ?? {}) as CollectingDataPayload;

  const values: CollectingWriteColumns = {
    companyObjective: payload.company_objective ?? null,
    analyticsGoal: payload.analytics_goal ?? null,
    businessSummary: payload.business_summary ?? null,
    mainProductsOrServices: payload.uses_company_products === false ? null : payload.main_products_or_services ?? null,
    usesCompanyProducts: payload.uses_company_products ?? false,
    usesCompanyServices: payload.uses_company_services ?? false,
    usesCompanyDepartments: payload.uses_company_departments ?? false,
  };

  // O upsert SEMPRE sincroniza as 3 perguntas COMPANY (defaults se não vierem).
  const normalizedQuestions = normalizeCompanyFeedbackQuestions(payload.company_feedback_questions);
  if (!normalizedQuestions) return sendTypedError(res, 400, API_ERROR_UPSERT_FAILED);

  const plan: SyncPlan = { catalog: buildCatalogSyncSteps(payload, 'upsert'), questions: normalizedQuestions };

  try {
    const collecting = await saveCollectingDataUpsert({ enterpriseId, values, plan });
    const catalog = await getCatalogSnapshot(enterpriseId);
    const companyFeedbackQuestions = await getCompanyQuestionsSnapshot(enterpriseId);
    return res.json({ collecting: { ...collecting, ...catalog, company_feedback_questions: companyFeedbackQuestions } });
  } catch (err) {
    if (err instanceof CollectingWriteError) return sendTypedError(res, 400, API_ERROR_UPSERT_FAILED);
    throw err;
  }
}
