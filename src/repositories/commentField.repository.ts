import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  DEFAULT_COMMENT_FIELD,
  type CommentFieldMode,
  type CommentFieldSettings,
  type CommentFieldSettingsPayload,
  type ScopeCommentField,
} from '@feedback/lib-shared/schemas/public/commentField';
import { getDb } from '../db/client.js';
import { collectionPoints, feedbackCommentField } from '../../drizzle/schema.js';
import { assertEnterpriseId } from '../db/tenantScope.js';

export type CommentFieldScopeType = CommentFieldSettingsPayload['scope_type'];

function toSettings(row: { mode: string; prompt: string | null } | undefined): CommentFieldSettings {
  if (!row) return DEFAULT_COMMENT_FIELD;
  const mode = (['DEFAULT', 'CUSTOM', 'HIDDEN'].includes(row.mode) ? row.mode : 'DEFAULT') as CommentFieldMode;
  return { mode, prompt: mode === 'CUSTOM' ? row.prompt : null };
}

/** WHERE do alvo: a empresa (sem item) ou um item do catálogo, sempre da empresa. */
function targetWhere(enterpriseId: string, scopeType: CommentFieldScopeType, catalogItemId: string | null): SQL {
  assertEnterpriseId(enterpriseId);
  return scopeType === 'COMPANY' || !catalogItemId
    ? (and(
        eq(feedbackCommentField.enterpriseId, enterpriseId),
        eq(feedbackCommentField.scopeType, 'COMPANY'),
        isNull(feedbackCommentField.catalogItemId),
      ) as SQL)
    : (and(
        eq(feedbackCommentField.enterpriseId, enterpriseId),
        eq(feedbackCommentField.catalogItemId, catalogItemId),
      ) as SQL);
}

/** Campo de comentário de um alvo; sem linha, o convite padrão. */
export async function fetchCommentField(params: {
  enterpriseId: string;
  scopeType: CommentFieldScopeType;
  catalogItemId: string | null;
}): Promise<CommentFieldSettings> {
  const [row] = await getDb()
    .select({ mode: feedbackCommentField.mode, prompt: feedbackCommentField.prompt })
    .from(feedbackCommentField)
    .where(targetWhere(params.enterpriseId, params.scopeType, params.catalogItemId))
    .limit(1);
  return toSettings(row);
}

/** Salva o campo do alvo (uma linha por alvo, pelos índices únicos parciais). */
export async function upsertCommentField(enterpriseId: string, payload: CommentFieldSettingsPayload): Promise<CommentFieldSettings> {
  assertEnterpriseId(enterpriseId);
  const isCompany = payload.scope_type === 'COMPANY';
  const values = {
    enterpriseId,
    scopeType: payload.scope_type,
    catalogItemId: isCompany ? null : payload.catalog_item_id,
    mode: payload.mode,
    prompt: payload.prompt,
  };
  const [row] = await getDb()
    .insert(feedbackCommentField)
    .values(values)
    .onConflictDoUpdate({
      target: isCompany
        ? [feedbackCommentField.enterpriseId]
        : [feedbackCommentField.enterpriseId, feedbackCommentField.catalogItemId],
      targetWhere: isCompany
        ? sql`scope_type = 'COMPANY' AND catalog_item_id IS NULL`
        : sql`catalog_item_id IS NOT NULL`,
      set: { mode: values.mode, prompt: values.prompt, updatedAt: sql`now()` },
    })
    .returning({ mode: feedbackCommentField.mode, prompt: feedbackCommentField.prompt });
  return toSettings(row);
}

/**
 * Como está o campo nos pontos de coleta de um recorte: um tipo inteiro reúne
 * vários itens, e cada um tem o seu campo. `null` = a empresa toda.
 */
export async function fetchScopeCommentField(params: {
  enterpriseId: string;
  collectionPointIds: string[] | null;
}): Promise<ScopeCommentField> {
  const { enterpriseId, collectionPointIds } = params;
  assertEnterpriseId(enterpriseId);
  if (collectionPointIds && collectionPointIds.length === 0) return { hidden: 'none', prompt: null };

  const db = getDb();
  const pointConds: SQL[] = [eq(collectionPoints.enterpriseId, enterpriseId)];
  if (collectionPointIds) pointConds.push(inArray(collectionPoints.id, collectionPointIds));
  const points = await db
    .selectDistinct({ catalogItemId: collectionPoints.catalogItemId })
    .from(collectionPoints)
    .where(and(...pointConds) as SQL);
  if (points.length === 0) return { hidden: 'none', prompt: null };

  const rows = await db
    .select({ catalogItemId: feedbackCommentField.catalogItemId, mode: feedbackCommentField.mode, prompt: feedbackCommentField.prompt })
    .from(feedbackCommentField)
    .where(eq(feedbackCommentField.enterpriseId, enterpriseId));
  const byTarget = new Map(rows.map((row) => [row.catalogItemId ?? 'COMPANY', toSettings(row)]));

  const settings = points.map((point) => byTarget.get(point.catalogItemId ?? 'COMPANY') ?? DEFAULT_COMMENT_FIELD);
  const hiddenCount = settings.filter((setting) => setting.mode === 'HIDDEN').length;
  const hidden = hiddenCount === 0 ? 'none' : hiddenCount === settings.length ? 'all' : 'some';
  const prompt = settings.length === 1 && settings[0].mode === 'CUSTOM' ? settings[0].prompt : null;
  return { hidden, prompt };
}
