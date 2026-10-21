/**
 * Porta em TypeScript do trigger `create_enterprise_on_signup` do Supabase.
 *
 * Provisiona a empresa do usuário recém-cadastrado: cria a `enterprise` (trial
 * de 4 meses, status TRIAL) e semeia as 3 perguntas padrão
 * no escopo COMPANY. Chamado pelo controller de registro logo após o
 * `auth.api.signUpEmail` bem-sucedido (o Better Auth já criou `user`/`account`).
 *
 * Roda numa transação Drizzle própria. Idempotente: `ON CONFLICT (auth_user_id)
 * DO NOTHING` na empresa e `NOT EXISTS` nas perguntas — re-executar não duplica.
 * O CPF/CNPJ não é mais pedido nem guardado (migration 0009): o sistema não usa
 * esse dado (LGPD, necessidade).
 *
 * A checagem de telefone duplicado NÃO fica aqui: no Better Auth o telefone é
 * coluna de `user` (UNIQUE), então a duplicidade é barrada na criação do usuário
 * e pré-checada no controller (paridade com o 409 `phone_taken`).
 */
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { DEFAULT_COMPANY_QUESTION_TEXTS } from '../config/defaultCompanyQuestions.js';

const DEFAULT_COMPANY_QUESTIONS: readonly string[] = DEFAULT_COMPANY_QUESTION_TEXTS;

export interface EnterpriseSignupMeta {
  termsVersion?: string | null;
  termsAcceptedAt?: string | null;
}

/** Cria a empresa + perguntas padrão para o usuário. */
export async function provisionEnterpriseForUser(
  userId: string,
  meta: EnterpriseSignupMeta,
): Promise<void> {
  const db = getDb();

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO public.enterprise
        (terms_version, terms_accepted_at, auth_user_id, trial_ends_at, subscription_status)
      VALUES
        (${meta.termsVersion ?? null}, ${meta.termsAcceptedAt ?? null}, ${userId},
         NOW() + INTERVAL '4 months', 'TRIAL')
      -- Quem entra com o Google já tem a empresa (criada na conta); ao completar o
      -- cadastro, só o aceite dos termos é gravado. Nunca apaga um aceite existente.
      ON CONFLICT (auth_user_id) DO UPDATE SET
        terms_version = COALESCE(EXCLUDED.terms_version, public.enterprise.terms_version),
        terms_accepted_at = COALESCE(EXCLUDED.terms_accepted_at, public.enterprise.terms_accepted_at)
    `);

    const rows = await tx.execute(
      sql`SELECT id FROM public.enterprise WHERE auth_user_id = ${userId} LIMIT 1`,
    );
    const enterpriseId = (rows[0] as { id?: string } | undefined)?.id;
    if (!enterpriseId) {
      return;
    }

    for (let i = 0; i < DEFAULT_COMPANY_QUESTIONS.length; i += 1) {
      const order = i + 1;
      const text = DEFAULT_COMPANY_QUESTIONS[i];
      await tx.execute(sql`
        INSERT INTO public.questions_of_feedbacks
          (enterprise_id, scope_type, catalog_item_id, question_order, question_text, is_active)
        SELECT ${enterpriseId}, 'COMPANY', NULL, ${order}, ${text}, true
        WHERE NOT EXISTS (
          SELECT 1 FROM public.questions_of_feedbacks existing
          WHERE existing.enterprise_id = ${enterpriseId}
            AND existing.scope_type = 'COMPANY'
            AND existing.catalog_item_id IS NULL
            AND existing.question_order = ${order}
        )
      `);
    }
  });
}
