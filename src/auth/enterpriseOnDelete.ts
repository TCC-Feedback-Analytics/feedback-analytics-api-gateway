/**
 * "Excluir minha conta" (etapa 07, LGPD art. 18): apaga a empresa do usuário e
 * tudo dela, antes de o Better Auth apagar o próprio usuário (`beforeDelete`).
 *
 * A maior parte some em cascata ao apagar a `enterprise` (feedbacks, análises,
 * catálogo, perguntas, pontos de coleta, aparelhos, configuração de IA, jobs,
 * diagnósticos). Três tabelas não têm chave estrangeira para a empresa e são
 * apagadas aqui: `customer`, `collecting_data_enterprise` e os contadores de
 * cota da IA (`ia_rate_budget`, com o id da empresa como escopo). Os links de
 * nova senha (`verification.value` = id do usuário) também saem. Depois, o Better
 * Auth apaga o usuário, e `session`, `account` e `user_onboarding` vão em cascata.
 *
 * Tudo numa transação: ou some tudo da empresa, ou nada.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';

export async function deleteEnterpriseOfUser(userId: string): Promise<void> {
  if (!userId) throw new Error('Exclusão de conta exige o id do usuário.');
  const enterpriseIds = sql`SELECT id FROM public.enterprise WHERE auth_user_id = ${userId}`;

  await getDb().transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM public.customer WHERE enterprise_id IN (${enterpriseIds})`);
    await tx.execute(sql`DELETE FROM public.collecting_data_enterprise WHERE enterprise_id IN (${enterpriseIds})`);
    await tx.execute(sql`DELETE FROM public.ia_rate_budget WHERE scope IN (SELECT id::text FROM public.enterprise WHERE auth_user_id = ${userId})`);
    await tx.execute(sql`DELETE FROM public.verification WHERE value = ${userId}`);
    await tx.execute(sql`DELETE FROM public.enterprise WHERE auth_user_id = ${userId}`);
  });
}
