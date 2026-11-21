/**
 * "Excluir minha conta" (LGPD, art. 18) no banco. O pedido vira um link de uso único
 * na tabela `verification`, a confirmação marca `user.deletion_scheduled_for` e
 * derruba as sessões, e a rotina diária apaga as contas cujo prazo venceu.
 *
 * Toda consulta é pelo id do usuário da sessão (ou da conta vencida, na rotina).
 */
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';

/** Prefixo do link na `verification`, separado dos links do Better Auth. */
const TOKEN_PREFIX = 'account-deletion:';

/** Hash da senha de quem entra com e-mail e senha. `null` para quem só entra pelo Google. */
export async function findPasswordHash(userId: string): Promise<string | null> {
  const rows = await getDb().execute(sql`
    SELECT password FROM public.account
    WHERE user_id = ${userId} AND provider_id = 'credential' AND password IS NOT NULL
    LIMIT 1
  `);
  return (rows[0] as { password?: string } | undefined)?.password ?? null;
}

/** Guarda só o hash do link: quem ler o banco não consegue usá-lo. */
export async function saveDeletionToken(userId: string, tokenHash: string, validForSeconds: number): Promise<void> {
  await getDb().execute(sql`
    INSERT INTO public.verification (identifier, value, expires_at)
    VALUES (${TOKEN_PREFIX + tokenHash}, ${userId}, now() + ${validForSeconds} * interval '1 second')
  `);
}

/** Gasta o link: só vale uma vez, dentro do prazo e para o dono da sessão. */
export async function consumeDeletionToken(userId: string, tokenHash: string): Promise<boolean> {
  const rows = await getDb().execute(sql`
    DELETE FROM public.verification
    WHERE identifier = ${TOKEN_PREFIX + tokenHash} AND value = ${userId} AND expires_at > now()
    RETURNING id
  `);
  return rows.length > 0;
}

/**
 * Marca a data da exclusão e encerra todas as sessões, numa transação. Quem estava
 * dentro, inclusive quem roubou a sessão, sai: para desistir é preciso entrar de novo.
 */
export async function scheduleDeletion(userId: string, graceDays: number): Promise<Date | null> {
  return getDb().transaction(async (tx) => {
    const rows = await tx.execute(sql`
      UPDATE public."user"
      SET deletion_scheduled_for = now() + ${graceDays} * interval '1 day', updated_at = now()
      WHERE id = ${userId} AND deletion_scheduled_for IS NULL
      RETURNING deletion_scheduled_for
    `);
    const scheduledFor = (rows[0] as { deletion_scheduled_for?: Date | string } | undefined)?.deletion_scheduled_for;
    if (!scheduledFor) return null;
    await tx.execute(sql`DELETE FROM public.session WHERE user_id = ${userId}`);
    return new Date(scheduledFor);
  });
}

/** Desistência: a conta volta como estava. `false` se não havia exclusão marcada. */
export async function cancelDeletion(userId: string): Promise<boolean> {
  const rows = await getDb().execute(sql`
    UPDATE public."user" SET deletion_scheduled_for = NULL, updated_at = now()
    WHERE id = ${userId} AND deletion_scheduled_for IS NOT NULL
    RETURNING id
  `);
  return rows.length > 0;
}

/** Contas com o prazo vencido, as mais antigas primeiro. */
export async function findAccountsDueForDeletion(limit: number): Promise<string[]> {
  const rows = await getDb().execute(sql`
    SELECT id FROM public."user"
    WHERE deletion_scheduled_for IS NOT NULL AND deletion_scheduled_for <= now()
    ORDER BY deletion_scheduled_for
    LIMIT ${limit}
  `);
  return rows.map((row) => String((row as { id: string }).id));
}

/**
 * Apaga a conta vencida e tudo dela numa transação: ou some tudo, ou nada. Devolve o
 * e-mail, para o aviso final, ou `null` se a pessoa desistiu antes (a trava da linha
 * do usuário espera um cancelamento em andamento terminar).
 *
 * A maior parte some em cascata ao apagar a `enterprise` (feedbacks, análises,
 * catálogo, perguntas, pontos de coleta, aparelhos, configuração de IA, jobs,
 * diagnósticos). Três tabelas não têm chave estrangeira para a empresa e saem antes:
 * `customer`, `collecting_data_enterprise` e os contadores de cota da IA
 * (`ia_rate_budget`, com o id da empresa como escopo). Os links pendentes do usuário
 * na `verification` também saem. Por último o usuário, com `session`, `account` e
 * `user_onboarding` em cascata.
 */
export async function purgeAccount(userId: string): Promise<string | null> {
  if (!userId) throw new Error('Exclusão de conta exige o id do usuário.');
  const enterpriseIds = sql`SELECT id FROM public.enterprise WHERE auth_user_id = ${userId}`;

  return getDb().transaction(async (tx) => {
    const due = await tx.execute(sql`
      SELECT email FROM public."user"
      WHERE id = ${userId} AND deletion_scheduled_for IS NOT NULL AND deletion_scheduled_for <= now()
      FOR UPDATE
    `);
    const email = (due[0] as { email?: string } | undefined)?.email;
    if (!email) return null;

    await tx.execute(sql`DELETE FROM public.customer WHERE enterprise_id IN (${enterpriseIds})`);
    await tx.execute(sql`DELETE FROM public.collecting_data_enterprise WHERE enterprise_id IN (${enterpriseIds})`);
    await tx.execute(sql`DELETE FROM public.ia_rate_budget WHERE scope IN (SELECT id::text FROM public.enterprise WHERE auth_user_id = ${userId})`);
    await tx.execute(sql`DELETE FROM public.verification WHERE value = ${userId}`);
    await tx.execute(sql`DELETE FROM public.enterprise WHERE auth_user_id = ${userId}`);
    await tx.execute(sql`DELETE FROM public."user" WHERE id = ${userId}`);
    return email;
  });
}
