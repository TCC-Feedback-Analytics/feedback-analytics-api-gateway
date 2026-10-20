import type { Request, Response } from 'express';
import {
  API_ERROR_ENTERPRISE_NOT_FOUND,
  API_ERROR_FAILED_TO_FETCH_FEEDBACK_ANALYSIS,
  API_ERROR_FAILED_TO_FETCH_STATS,
  API_ERROR_INTERNAL_SERVER_ERROR,
  API_ERROR_INVALID_PERIOD,
  API_ERROR_INVALID_TIMELINE,
  API_ERROR_TIMELINE_TOO_MANY_POINTS,
} from '../../config/errors.js';
import { resolveScopeCollectionPointIds } from '../../repositories/scope.repository.js';
import { resolveEnterpriseIdByUser } from '../../repositories/enterprise.repository.js';
import { fetchScopedInsightsReport } from '../../repositories/feedbackInsights.repository.js';
import { sendTypedError } from '../../utils/sendTypedError.js';
import {
  resolveCategoryCollectionPointIds,
  countScopedFeedbacks,
  fetchScopedFeedbackPage,
  fetchCatalogItemsByIds,
  fetchAnswersForFeedbacks,
} from '../../repositories/feedbackList.repository.js';
import { parseMetricsPeriod } from '../../libs/period.js';
import { parseTimelineBucket, parseTimezone } from '../../libs/timeline.js';
import {
  computeScopedAnalysis,
  computeScopedCustomers,
  computeScopedHeatmap,
  computeScopedStats,
  computeScopedTimeline,
} from '../../services/scopeMetrics.service.js';
import { computeScopedQuestionMetrics } from '../../services/questionMetrics.service.js';

type FeedbackCollectionPoint = {
  id?: string;
  name?: string;
  type?: string;
  identifier?: string | null;
  catalog_item_id?: string | null;
};

type CatalogItemRow = {
  id: string;
  name: string;
  kind: string | null;
};

type FeedbackListRow = {
  id: string;
  collection_points: FeedbackCollectionPoint | FeedbackCollectionPoint[] | null;
} & Record<string, unknown>;

function resolveCollectionPoint(
  collectionPointRaw: FeedbackCollectionPoint | FeedbackCollectionPoint[] | null | undefined,
) {
  if (Array.isArray(collectionPointRaw)) return collectionPointRaw[0] ?? null;
  return collectionPointRaw ?? null;
}

function parseInsightScopeType(rawValue: unknown) {
  const normalized = String(rawValue ?? '').trim().toUpperCase();
  if (
    normalized === 'COMPANY' ||
    normalized === 'PRODUCT' ||
    normalized === 'SERVICE' ||
    normalized === 'DEPARTMENT'
  ) {
    return normalized;
  }
  return undefined;
}

export async function getFeedbacksController(req: Request, res: Response) {
  const user = req.user!;

  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 10;
  const offset = (page - 1) * limit;

  const rating = req.query.rating ? parseInt(req.query.rating as string) : null;
  const search = (req.query.search as string) || '';
  const item = String(req.query.item ?? '').trim();
  const categoryRaw = String(req.query.category ?? '').trim().toUpperCase();

  const category =
    categoryRaw === 'COMPANY' ||
    categoryRaw === 'PRODUCT' ||
    categoryRaw === 'SERVICE' ||
    categoryRaw === 'DEPARTMENT'
      ? categoryRaw
      : null;

  try {
    const enterpriseId = req.enterpriseId ?? (await resolveEnterpriseIdByUser(user.id));
    if (!enterpriseId) {
      return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);
    }

    const filteredCollectionPointIds = await resolveCategoryCollectionPointIds({
      enterpriseId,
      category,
      item,
    });

    if (filteredCollectionPointIds && filteredCollectionPointIds.length === 0) {
      return res.json({
        feedbacks: [],
        pagination: {
          currentPage: page,
          totalPages: 0,
          totalItems: 0,
          itemsPerPage: limit,
          hasNextPage: false,
          hasPreviousPage: page > 1,
        },
      });
    }

    const listFilter = { rating, search, collectionPointIds: filteredCollectionPointIds };
    const count = await countScopedFeedbacks(enterpriseId, listFilter);
    const totalPages = Math.ceil((count || 0) / limit);
    const feedbackRows = (await fetchScopedFeedbackPage({
      enterpriseId,
      filter: listFilter,
      limit,
      offset,
    })) as FeedbackListRow[];

    const catalogItemIds = Array.from(
      new Set(
        feedbackRows
          .map((feedback) => resolveCollectionPoint(feedback.collection_points)?.catalog_item_id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    );

    let catalogItemById = new Map<string, { name: string; kind: 'PRODUCT' | 'SERVICE' | 'DEPARTMENT' }>();

    if (catalogItemIds.length > 0) {
      const catalogRows = await fetchCatalogItemsByIds(enterpriseId, catalogItemIds);

      catalogItemById = new Map(
        ((catalogRows ?? []) as CatalogItemRow[])
          .map((row) => {
            const normalizedKind = String(row.kind ?? '').toUpperCase();
            const kind =
              normalizedKind === 'PRODUCT' ||
              normalizedKind === 'SERVICE' ||
              normalizedKind === 'DEPARTMENT'
                ? normalizedKind
                : null;
            if (!kind || typeof row.id !== 'string') return null;
            return [row.id, { name: row.name, kind }] as const;
          })
          .filter((entry): entry is readonly [string, { name: string; kind: 'PRODUCT' | 'SERVICE' | 'DEPARTMENT' }] => Boolean(entry)),
      );
    }

    const normalizedFeedbacks = feedbackRows.map((feedback) => {
      const collectionPoint = resolveCollectionPoint(feedback.collection_points);
      if (!collectionPoint) return feedback;

      const catalogItem = collectionPoint.catalog_item_id
        ? (catalogItemById.get(collectionPoint.catalog_item_id) ?? null)
        : null;

      return {
        ...feedback,
        collection_points: {
          ...collectionPoint,
          catalog_item_name: catalogItem?.name ?? null,
          catalog_item_kind: catalogItem?.kind ?? null,
          catalog_items: catalogItem,
        },
      };
    });

    const feedbackIds = normalizedFeedbacks
      .map((feedback) => feedback.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    const answersByFeedbackId = new Map<
      string,
      Array<{
        question_id: string;
        question_text_snapshot: string;
        answer_value: 'PESSIMO' | 'RUIM' | 'MEDIANA' | 'BOA' | 'OTIMA';
        answer_score: number;
      }>
    >();

    if (feedbackIds.length > 0) {
      const answerRows = await fetchAnswersForFeedbacks(feedbackIds);
      for (const row of answerRows) {
        const current = answersByFeedbackId.get(row.feedback_id) ?? [];
        current.push({
          question_id: row.question_id,
          question_text_snapshot: row.question_text_snapshot,
          answer_value: row.answer_value as 'PESSIMO' | 'RUIM' | 'MEDIANA' | 'BOA' | 'OTIMA',
          answer_score: row.answer_score,
        });
        answersByFeedbackId.set(row.feedback_id, current);
      }
    }

    const normalizedFeedbacksWithAnswers = normalizedFeedbacks.map((feedback) => ({
      ...feedback,
      feedback_question_answers: answersByFeedbackId.get(feedback.id) ?? [],
    }));

    return res.json({
      feedbacks: normalizedFeedbacksWithAnswers,
      pagination: {
        currentPage: page,
        totalPages,
        totalItems: count || 0,
        itemsPerPage: limit,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    });
  } catch (error) {
    console.error('Erro ao buscar feedbacks:', error);
    return sendTypedError(res, 500, API_ERROR_INTERNAL_SERVER_ERROR);
  }
}

export async function getFeedbacksStatsController(req: Request, res: Response) {
  const user = req.user!;

  const scopeType = parseInsightScopeType(req.query.scope_type);
  const catalogItemId = String(req.query.catalog_item_id ?? '').trim() || null;
  const parsedPeriod = parseMetricsPeriod(req.query);
  if ('error' in parsedPeriod) return sendTypedError(res, 400, API_ERROR_INVALID_PERIOD);
  const { period } = parsedPeriod;

  try {
    const enterpriseId = req.enterpriseId ?? (await resolveEnterpriseIdByUser(user.id));
    if (!enterpriseId) {
      return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);
    }

    // Métricas filtradas pelo escopo selecionado no header (Geral = só o QR da empresa).
    const scopeResolution = await resolveScopeCollectionPointIds({
      enterpriseId,
      scopeType,
      catalogItemId,
    });

    if (scopeResolution.error) {
      return sendTypedError(res, 500, API_ERROR_FAILED_TO_FETCH_STATS);
    }

    const filteredCollectionPointIds = scopeResolution.ids;

    return res.json(await computeScopedStats({
      enterpriseId,
      collectionPointIds: filteredCollectionPointIds,
      period,
    }));
  } catch (error) {
    console.error('Erro ao buscar estatísticas:', error);
    return sendTypedError(res, 500, API_ERROR_INTERNAL_SERVER_ERROR);
  }
}

export async function getFeedbacksInsightsReportController(req: Request, res: Response) {
  const user = req.user!;
  const scopeType = parseInsightScopeType(req.query.scope_type) ?? 'COMPANY';
  const catalogItemId = String(req.query.catalog_item_id ?? '').trim() || null;

  try {
    const enterpriseId = req.enterpriseId ?? (await resolveEnterpriseIdByUser(user.id));
    if (!enterpriseId) {
      return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);
    }

    // Com o schema atual `scope_type` está sempre presente → a query escopada é
    // autoritativa (o antigo fallback legado por empresa, sem escopo, foi removido).
    const report = await fetchScopedInsightsReport({ enterpriseId, scopeType, catalogItemId });

    if (!report) {
      return res.json({ summary: null, recommendations: [], updatedAt: null, scopeType, catalogItemId });
    }

    return res.json({
      summary: report.summary ?? null,
      recommendations: (report.recommendations ?? []).filter((rec) => !!rec && rec.trim().length > 0),
      updatedAt: report.updatedAt ?? null,
      scopeType: report.scopeType ?? scopeType,
      catalogItemId: report.catalogItemId ?? catalogItemId,
    });
  } catch (error) {
    console.error('Erro ao buscar relatório de insights (IA):', error);
    return sendTypedError(res, 500, API_ERROR_INTERNAL_SERVER_ERROR);
  }
}

export async function getFeedbacksAnalysisController(req: Request, res: Response) {
  const user = req.user!;

  const sentimentFilter = (req.query.sentiment as 'positive' | 'neutral' | 'negative' | undefined) ?? undefined;
  const scopeType = parseInsightScopeType(req.query.scope_type);
  const catalogItemId = String(req.query.catalog_item_id ?? '').trim() || null;
  const parsedPeriod = parseMetricsPeriod(req.query);
  if ('error' in parsedPeriod) return sendTypedError(res, 400, API_ERROR_INVALID_PERIOD);
  const { period } = parsedPeriod;

  try {
    const enterpriseId = req.enterpriseId ?? (await resolveEnterpriseIdByUser(user.id));
    if (!enterpriseId) {
      return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);
    }

    const scopeResolution = await resolveScopeCollectionPointIds({
      enterpriseId,
      scopeType,
      catalogItemId,
    });

    if (scopeResolution.error) {
      return sendTypedError(res, 500, API_ERROR_FAILED_TO_FETCH_FEEDBACK_ANALYSIS);
    }

    return res.json(await computeScopedAnalysis({
      enterpriseId,
      collectionPointIds: scopeResolution.ids,
      sentiment: sentimentFilter,
      period,
    }));
  } catch (error) {
    console.error('Erro ao buscar análises de feedbacks (IA):', error);
    return sendTypedError(res, 500, API_ERROR_INTERNAL_SERVER_ERROR);
  }
}

/**
 * Métricas por pergunta/subpergunta (escala 1–5), agregadas no escopo e no
 * período. O cálculo vive em services/questionMetrics.service.ts.
 */
export async function getFeedbacksQuestionsController(req: Request, res: Response) {
  const user = req.user!;

  const scopeType = parseInsightScopeType(req.query.scope_type);
  const catalogItemId = String(req.query.catalog_item_id ?? '').trim() || null;
  const parsedPeriod = parseMetricsPeriod(req.query);
  if ('error' in parsedPeriod) return sendTypedError(res, 400, API_ERROR_INVALID_PERIOD);
  const { period } = parsedPeriod;

  try {
    const enterpriseId = req.enterpriseId ?? (await resolveEnterpriseIdByUser(user.id));
    if (!enterpriseId) {
      return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);
    }

    const scopeResolution = await resolveScopeCollectionPointIds({
      enterpriseId,
      scopeType,
      catalogItemId,
    });

    if (scopeResolution.error) {
      return sendTypedError(res, 500, API_ERROR_FAILED_TO_FETCH_STATS);
    }

    const questions = await computeScopedQuestionMetrics({
      enterpriseId,
      collectionPointIds: scopeResolution.ids,
      period,
    });

    return res.json({ questions });
  } catch (error) {
    console.error('Erro ao buscar métricas por pergunta:', error);
    return sendTypedError(res, 500, API_ERROR_INTERNAL_SERVER_ERROR);
  }
}

/**
 * Movimento no tempo (métricas novas, 1): quantas avaliações chegaram e a média
 * por dia, semana ou mês, no escopo e no período escolhidos, no fuso do gestor.
 * Os intervalos sem avaliação vêm com zero, para o gráfico não pular datas.
 */
export async function getFeedbacksTimelineController(req: Request, res: Response) {
  const user = req.user!;

  const scopeType = parseInsightScopeType(req.query.scope_type);
  const catalogItemId = String(req.query.catalog_item_id ?? '').trim() || null;
  const parsedPeriod = parseMetricsPeriod(req.query);
  if ('error' in parsedPeriod) return sendTypedError(res, 400, API_ERROR_INVALID_PERIOD);
  const { period } = parsedPeriod;
  const bucket = parseTimelineBucket(req.query.bucket);
  const timeZone = parseTimezone(req.query.tz);
  if (!bucket || !timeZone) return sendTypedError(res, 400, API_ERROR_INVALID_TIMELINE);

  try {
    const enterpriseId = req.enterpriseId ?? (await resolveEnterpriseIdByUser(user.id));
    if (!enterpriseId) {
      return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);
    }

    const scopeResolution = await resolveScopeCollectionPointIds({ enterpriseId, scopeType, catalogItemId });
    if (scopeResolution.error) {
      return sendTypedError(res, 500, API_ERROR_FAILED_TO_FETCH_STATS);
    }

    const points = await computeScopedTimeline({
      enterpriseId,
      collectionPointIds: scopeResolution.ids,
      period,
      bucket,
      timeZone,
    });
    if (!points) return sendTypedError(res, 400, API_ERROR_TIMELINE_TOO_MANY_POINTS);

    return res.json({
      bucket,
      tz: timeZone,
      total: points.reduce((sum, point) => sum + point.count, 0),
      points,
    });
  } catch (error) {
    console.error('Erro ao buscar o movimento das avaliações:', error);
    return sendTypedError(res, 500, API_ERROR_INTERNAL_SERVER_ERROR);
  }
}

/**
 * Dias e horários de pico (métricas novas, 3): quantas avaliações chegaram e a
 * média em cada dia da semana × faixa do dia (madrugada, manhã, tarde, noite),
 * no escopo e no período escolhidos, no fuso do gestor. Sempre as 28 células.
 */
export async function getFeedbacksHeatmapController(req: Request, res: Response) {
  const user = req.user!;

  const scopeType = parseInsightScopeType(req.query.scope_type);
  const catalogItemId = String(req.query.catalog_item_id ?? '').trim() || null;
  const parsedPeriod = parseMetricsPeriod(req.query);
  if ('error' in parsedPeriod) return sendTypedError(res, 400, API_ERROR_INVALID_PERIOD);
  const { period } = parsedPeriod;
  const timeZone = parseTimezone(req.query.tz);
  if (!timeZone) return sendTypedError(res, 400, API_ERROR_INVALID_TIMELINE);

  try {
    const enterpriseId = req.enterpriseId ?? (await resolveEnterpriseIdByUser(user.id));
    if (!enterpriseId) {
      return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);
    }

    const scopeResolution = await resolveScopeCollectionPointIds({ enterpriseId, scopeType, catalogItemId });
    if (scopeResolution.error) {
      return sendTypedError(res, 500, API_ERROR_FAILED_TO_FETCH_STATS);
    }

    const cells = await computeScopedHeatmap({ enterpriseId, collectionPointIds: scopeResolution.ids, period, timeZone });

    return res.json({
      tz: timeZone,
      total: cells.reduce((sum, cell) => sum + cell.count, 0),
      cells,
    });
  } catch (error) {
    console.error('Erro ao buscar os dias e horários de pico:', error);
    return sendTypedError(res, 500, API_ERROR_INTERNAL_SERVER_ERROR);
  }
}

/**
 * Clientes que voltam (métricas novas, 4): quantas avaliações vieram de quem já
 * tinha avaliado a empresa e se a nota de quem volta é maior ou menor que a de
 * quem avalia pela primeira vez, no escopo e no período escolhidos. "Cliente" é
 * o aparelho identificado pelo anti-spam: o número é aproximado.
 */
export async function getFeedbacksCustomersController(req: Request, res: Response) {
  const user = req.user!;

  const scopeType = parseInsightScopeType(req.query.scope_type);
  const catalogItemId = String(req.query.catalog_item_id ?? '').trim() || null;
  const parsedPeriod = parseMetricsPeriod(req.query);
  if ('error' in parsedPeriod) return sendTypedError(res, 400, API_ERROR_INVALID_PERIOD);
  const { period } = parsedPeriod;

  try {
    const enterpriseId = req.enterpriseId ?? (await resolveEnterpriseIdByUser(user.id));
    if (!enterpriseId) {
      return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);
    }

    const scopeResolution = await resolveScopeCollectionPointIds({ enterpriseId, scopeType, catalogItemId });
    if (scopeResolution.error) {
      return sendTypedError(res, 500, API_ERROR_FAILED_TO_FETCH_STATS);
    }

    return res.json(await computeScopedCustomers({
      enterpriseId,
      collectionPointIds: scopeResolution.ids,
      period,
    }));
  } catch (error) {
    console.error('Erro ao buscar os clientes que voltam:', error);
    return sendTypedError(res, 500, API_ERROR_INTERNAL_SERVER_ERROR);
  }
}
