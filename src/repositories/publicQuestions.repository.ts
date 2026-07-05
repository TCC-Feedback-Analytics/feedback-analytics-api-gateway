import { asc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { feedbackQuestionSubquestions, questionsOfFeedbacks } from '../../drizzle/schema.js';
import { scopedByEnterprise } from '../db/tenantScope.js';

export type PublicQuestionScope = 'COMPANY' | 'PRODUCT' | 'SERVICE' | 'DEPARTMENT';

export interface PublicSubquestionRow {
  id: string;
  question_id: string;
  subquestion_order: number;
  subquestion_text: string;
  is_active: boolean;
}

export interface PublicQuestionRow {
  id: string;
  scope_type: string;
  catalog_item_id: string | null;
  question_order: number;
  question_text: string;
  subquestions: PublicSubquestionRow[];
}

/**
 * Busca as perguntas ATIVAS configuradas para um escopo do feedback público.
 *
 * - COMPANY (Geral): perguntas com `catalog_item_id IS NULL`.
 * - PRODUCT/SERVICE/DEPARTMENT: perguntas do `catalog_item_id` informado
 *   (ou `catalog_item_id IS NULL` como degradação quando não há item de contexto).
 *
 * Via Drizzle: SEMPRE filtra por `enterprise_id` (a role do Drizzle ignora a RLS)
 * — é a fonte de verdade do formulário público e do anti-tampering do submit.
 * As subperguntas vêm todas (com `is_active`); quem chama filtra as ativas.
 *
 * Mantém o formato `{ data, error }` para o uso permanecer idêntico nos
 * controllers públicos enquanto o fluxo anônimo não é migrado por completo.
 */
export async function fetchActiveQuestionsForScope(params: {
  enterpriseId: string;
  scopeType: PublicQuestionScope;
  catalogItemId: string | null;
}): Promise<{ data: PublicQuestionRow[] | null; error: unknown }> {
  const { enterpriseId, scopeType, catalogItemId } = params;

  try {
    const db = getDb();

    const catalogCond: SQL =
      scopeType === 'COMPANY'
        ? isNull(questionsOfFeedbacks.catalogItemId)
        : catalogItemId
          ? eq(questionsOfFeedbacks.catalogItemId, catalogItemId)
          : isNull(questionsOfFeedbacks.catalogItemId);

    const questions = await db
      .select({
        id: questionsOfFeedbacks.id,
        scope_type: questionsOfFeedbacks.scopeType,
        catalog_item_id: questionsOfFeedbacks.catalogItemId,
        question_order: questionsOfFeedbacks.questionOrder,
        question_text: questionsOfFeedbacks.questionText,
      })
      .from(questionsOfFeedbacks)
      .where(
        scopedByEnterprise(
          questionsOfFeedbacks.enterpriseId,
          enterpriseId,
          eq(questionsOfFeedbacks.scopeType, scopeType),
          eq(questionsOfFeedbacks.isActive, true),
          catalogCond,
        ),
      )
      .orderBy(asc(questionsOfFeedbacks.questionOrder));

    const questionIds = questions.map((q) => q.id);
    const subsByQuestion = new Map<string, PublicSubquestionRow[]>();

    if (questionIds.length > 0) {
      const subs = await db
        .select({
          id: feedbackQuestionSubquestions.id,
          question_id: feedbackQuestionSubquestions.questionId,
          subquestion_order: feedbackQuestionSubquestions.subquestionOrder,
          subquestion_text: feedbackQuestionSubquestions.subquestionText,
          is_active: feedbackQuestionSubquestions.isActive,
        })
        .from(feedbackQuestionSubquestions)
        .where(inArray(feedbackQuestionSubquestions.questionId, questionIds))
        .orderBy(asc(feedbackQuestionSubquestions.subquestionOrder));

      for (const s of subs) {
        const cur = subsByQuestion.get(s.question_id) ?? [];
        cur.push(s);
        subsByQuestion.set(s.question_id, cur);
      }
    }

    const data: PublicQuestionRow[] = questions.map((q) => ({
      ...q,
      subquestions: subsByQuestion.get(q.id) ?? [],
    }));

    return { data, error: null };
  } catch (error) {
    return { data: null, error };
  }
}
