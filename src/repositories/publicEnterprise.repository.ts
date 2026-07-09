import { eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { catalogItems, collectionPoints } from '../../drizzle/schema.js';
import { scopedCollectionPointWhere } from '../db/tenantScope.js';

export interface PublicEnterprise {
  id: string;
  name: string | null;
}

/**
 * Empresa pública (id + nome) via view `enterprise_public`. `null` se não existir.
 * A view resolve o nome por public.user.
 */
export async function getPublicEnterpriseById(id: string): Promise<PublicEnterprise | null> {
  const rows = await getDb().execute(
    sql`SELECT id, name FROM public.enterprise_public WHERE id = ${id} LIMIT 1`,
  );
  const row = rows[0] as { id?: string; name?: string | null } | undefined;
  return row?.id ? { id: row.id, name: row.name ?? null } : null;
}

export interface QrCollectionPoint {
  id: string;
  name: string | null;
  catalogItemId: string | null;
  catalogItemName: string | null;
  catalogItemKind: string | null;
}

/**
 * Resolve o ponto de coleta QR **ATIVO** do escopo — por id, por item de catálogo,
 * ou o "geral" (`catalog_item_id IS NULL`). SEMPRE tenant-scoped por `enterprise_id`
 * (a role do Drizzle ignora a RLS). Faz `leftJoin` no catálogo p/ o nome/kind.
 */
export async function resolveQrCollectionPoint(params: {
  enterpriseId: string;
  collectionPointId?: string | null;
  catalogItemId?: string | null;
}): Promise<QrCollectionPoint | null> {
  const { enterpriseId, collectionPointId, catalogItemId } = params;

  const opts: { type: string; status: string; id?: string; catalogItemId?: string | null } = {
    type: 'QR_CODE',
    status: 'ACTIVE',
  };
  if (collectionPointId) opts.id = collectionPointId;
  else if (catalogItemId) opts.catalogItemId = catalogItemId;
  else opts.catalogItemId = null; // ponto "geral"

  const rows = await getDb()
    .select({
      id: collectionPoints.id,
      name: collectionPoints.name,
      catalogItemId: collectionPoints.catalogItemId,
      catalogItemName: catalogItems.name,
      catalogItemKind: catalogItems.kind,
    })
    .from(collectionPoints)
    .leftJoin(catalogItems, eq(catalogItems.id, collectionPoints.catalogItemId))
    .where(scopedCollectionPointWhere(enterpriseId, opts))
    .limit(1);

  return rows[0] ?? null;
}
