import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { questionsOfFeedbacks, feedbackQuestionSubquestions } from '../../drizzle/schema.js';
import { scopedByEnterprise } from '../db/tenantScope.js';

export interface QuestionDef {
  id: string;
  questionText: string;
  isActive: boolean;
}

export interface SubquestionDef {
  id: string;
  questionId: string;
  subquestionText: string;
  isActive: boolean;
}

/**
 * Config atual das perguntas (por id) DA EMPRESA. O `eq(enterprise_id)` é
 * OBRIGATÓRIO: sem RLS (a role do Drizzle ignora), buscar só por id vazaria a
 * config de perguntas de outra empresa.
 */
export async function fetchQuestionDefsScoped(
  enterpriseId: string,
  questionIds: string[],
): Promise<QuestionDef[]> {
  if (questionIds.length === 0) return [];
  return getDb()
    .select({
      id: questionsOfFeedbacks.id,
      questionText: questionsOfFeedbacks.questionText,
      isActive: questionsOfFeedbacks.isActive,
    })
    .from(questionsOfFeedbacks)
    .where(
      scopedByEnterprise(
        questionsOfFeedbacks.enterpriseId,
        enterpriseId,
        inArray(questionsOfFeedbacks.id, questionIds),
      ),
    );
}

/**
 * Config das subperguntas (por id). `feedback_question_subquestions` não tem
 * `enterprise_id` próprio → reforçamos o tenant via JOIN na pergunta-pai
 * (`questions_of_feedbacks.enterprise_id`), além do isolamento transitivo dos ids.
 */
export async function fetchSubquestionDefsScoped(
  enterpriseId: string,
  subIds: string[],
): Promise<SubquestionDef[]> {
  if (subIds.length === 0) return [];
  return getDb()
    .select({
      id: feedbackQuestionSubquestions.id,
      questionId: feedbackQuestionSubquestions.questionId,
      subquestionText: feedbackQuestionSubquestions.subquestionText,
      isActive: feedbackQuestionSubquestions.isActive,
    })
    .from(feedbackQuestionSubquestions)
    .innerJoin(
      questionsOfFeedbacks,
      eq(questionsOfFeedbacks.id, feedbackQuestionSubquestions.questionId),
    )
    .where(
      and(
        inArray(feedbackQuestionSubquestions.id, subIds),
        eq(questionsOfFeedbacks.enterpriseId, enterpriseId),
      ),
    );
}
