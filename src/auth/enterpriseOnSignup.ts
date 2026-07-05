/**
 * Porta em TypeScript do trigger `create_enterprise_on_signup` do Supabase.
 *
 * Provisiona a empresa do usuário recém-cadastrado: valida documento, cria a
 * `enterprise` (trial de 4 meses, status TRIAL) e semeia as 3 perguntas padrão
 * no escopo COMPANY. Chamado pelo controller de registro logo após o
 * `auth.api.signUpEmail` bem-sucedido (o Better Auth já criou `user`/`account`).
 *
 * Roda numa transação Drizzle própria. Idempotente: `ON CONFLICT (auth_user_id)
 * DO NOTHING` na empresa e `NOT EXISTS` nas perguntas — re-executar não duplica.
 * A duplicidade de documento é barrada pela UNIQUE `enterprise_document_key`
 * (o SELECT prévio é só para a mensagem 409 amigável).
 *
 * A checagem de telefone duplicado NÃO fica aqui: no Better Auth o telefone é
 * coluna de `user` (UNIQUE), então a duplicidade é barrada na criação do usuário
 * e pré-checada no controller (paridade com o 409 `phone_taken`).
 */
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';

/** Documento ausente no cadastro (→ 400 `document_required`). */
export class DocumentRequiredError extends Error {
  constructor() {
    super('document is required');
    this.name = 'DocumentRequiredError';
  }
}

/** Documento já usado por outra empresa (→ 409 `document_taken`). */
export class DocumentTakenError extends Error {
  constructor() {
    super('document_already_exists');
    this.name = 'DocumentTakenError';
  }
}

/** Textos/ordem EXATOS das 3 perguntas COMPANY padrão (do trigger original). */
const DEFAULT_COMPANY_QUESTIONS: readonly string[] = [
  'Como foi sua experiência em relação ao atendimento?',
  'O que você achou da qualidade do produto/serviço?',
  'Como você avalia a relação entre o valor pago e a qualidade do produto/serviço?',
];

export interface EnterpriseSignupMeta {
  accountType?: string | null;
  document?: string | null;
  termsVersion?: string | null;
  termsAcceptedAt?: string | null;
}

const PG_UNIQUE_VIOLATION = '23505';

/**
 * Cria a empresa + perguntas padrão para o usuário. Lança `DocumentRequiredError`
 * / `DocumentTakenError` para o controller mapear aos códigos tipados.
 */
export async function provisionEnterpriseForUser(
  userId: string,
  meta: EnterpriseSignupMeta,
): Promise<void> {
  const document = meta.document?.trim() || null;
  if (!document) {
    throw new DocumentRequiredError();
  }

  const db = getDb();

  await db.transaction(async (tx) => {
    // Duplicidade de documento (mensagem amigável; a barreira real é a UNIQUE).
    const dup = await tx.execute(
      sql`SELECT 1 FROM public.enterprise WHERE document = ${document} LIMIT 1`,
    );
    if (dup.length > 0) {
      throw new DocumentTakenError();
    }

    try {
      await tx.execute(sql`
        INSERT INTO public.enterprise
          (document, account_type, terms_version, terms_accepted_at, auth_user_id, trial_ends_at, subscription_status)
        VALUES
          (${document}, ${meta.accountType ?? null}, ${meta.termsVersion ?? null},
           ${meta.termsAcceptedAt ?? null}, ${userId}, NOW() + INTERVAL '4 months', 'TRIAL')
        ON CONFLICT (auth_user_id) DO NOTHING
      `);
    } catch (err) {
      // Corrida: outro signup gravou o mesmo documento entre o SELECT e o INSERT.
      if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        throw new DocumentTakenError();
      }
      throw err;
    }

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
