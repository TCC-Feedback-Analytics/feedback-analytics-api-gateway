import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { enterprise } from '../../drizzle/schema.js';

/**
 * Resolve o id da empresa do usuário (por `auth_user_id`) via Drizzle. Retorna
 * `null` se o usuário não tiver empresa.
 *
 * Em modo Better Auth prefira `req.enterpriseId` (já resolvido no `requireAuth`);
 * este helper cobre o caso em que o middleware não injetou o enterpriseId
 * (ex.: modo supabase) e substitui o antigo `supabase.from('enterprise')...`.
 * É tenant-safe: filtra pelo `auth_user_id` do próprio usuário.
 */
export async function resolveEnterpriseIdByUser(userId: string): Promise<string | null> {
  const rows = await getDb()
    .select({ id: enterprise.id })
    .from(enterprise)
    .where(eq(enterprise.authUserId, userId))
    .limit(1);
  return rows[0]?.id ?? null;
}
