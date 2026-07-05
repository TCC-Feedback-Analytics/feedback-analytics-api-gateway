import { eq } from 'drizzle-orm';
import type { IaAnalyzeScopeType } from '@feedback/lib-shared/interfaces/contracts/ia-analyze/scope.contract';
import { getDb } from '../db/client.js';
import { catalogItems, collectionPoints } from '../../drizzle/schema.js';
import { scopedByEnterprise, scopedCollectionPointWhere } from '../db/tenantScope.js';

type IdRow = { id: string };

/**
 * Resultado da resolução de escopo → ids de `collection_point`:
 *  - `{ ids: null }`     => sem filtro de escopo (todos os feedbacks da empresa)
 *  - `{ ids: string[] }` => filtrar `feedback` por esses ids (`[]` => nenhum resultado)
 *  - `{ error: true }`   => falha de query (o chamador escolhe o código de erro)
 */
export type ScopeCollectionPointResolution =
  | { error: true }
  | { error: false; ids: string[] | null };

/**
 * Resolve o escopo selecionado (header) para a lista de `collection_point` ids
 * que as métricas/análises devem considerar. Via Drizzle (tenant-scoped): SEMPRE
 * filtra por `enterprise_id` — a role do Drizzle ignora a RLS, então esse filtro
 * é a única barreira cross-tenant.
 *
 * COMPANY (Geral) => apenas o ponto de coleta da empresa (`catalog_item_id IS NULL`).
 * Compartilhado por stats, analysis e pela regeneração de insights.
 */
export async function resolveScopeCollectionPointIds(params: {
  enterpriseId: string;
  scopeType: IaAnalyzeScopeType | undefined;
  catalogItemId: string | null;
}): Promise<ScopeCollectionPointResolution> {
  const { enterpriseId, scopeType, catalogItemId } = params;

  if (!scopeType && !catalogItemId) {
    return { error: false, ids: null };
  }

  const db = getDb();

  try {
    if (scopeType === 'COMPANY') {
      if (catalogItemId) {
        return { error: false, ids: [] };
      }
      const points: IdRow[] = await db
        .select({ id: collectionPoints.id })
        .from(collectionPoints)
        .where(scopedCollectionPointWhere(enterpriseId, { catalogItemId: null }));
      return { error: false, ids: points.map((cp) => cp.id) };
    }

    if (catalogItemId) {
      if (scopeType) {
        // Confirma que o item pertence à empresa E é do kind pedido.
        const item = await db
          .select({ id: catalogItems.id })
          .from(catalogItems)
          .where(
            scopedByEnterprise(
              catalogItems.enterpriseId,
              enterpriseId,
              eq(catalogItems.id, catalogItemId),
              eq(catalogItems.kind, scopeType),
            ),
          )
          .limit(1);
        if (item.length === 0) {
          return { error: false, ids: [] };
        }
      }

      const points: IdRow[] = await db
        .select({ id: collectionPoints.id })
        .from(collectionPoints)
        .where(scopedCollectionPointWhere(enterpriseId, { catalogItemId }));
      return { error: false, ids: points.map((cp) => cp.id) };
    }

    // scopeType sem catalogItemId (todos os itens de um kind).
    if (scopeType) {
      const items = await db
        .select({ id: catalogItems.id })
        .from(catalogItems)
        .where(scopedByEnterprise(catalogItems.enterpriseId, enterpriseId, eq(catalogItems.kind, scopeType)));

      const catalogIds = items.map((item) => item.id);
      if (catalogIds.length === 0) {
        return { error: false, ids: [] };
      }

      const points: IdRow[] = await db
        .select({ id: collectionPoints.id })
        .from(collectionPoints)
        .where(scopedCollectionPointWhere(enterpriseId, { catalogItemIds: catalogIds }));
      return { error: false, ids: points.map((cp) => cp.id) };
    }

    return { error: false, ids: null };
  } catch {
    return { error: true };
  }
}
