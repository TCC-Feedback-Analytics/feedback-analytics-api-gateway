import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CompanyQuestionSuggestionsRemoteResponse } from '@feedback/lib-shared/interfaces/contracts/ia-analyze/company-question-suggestions.contract';
import { IaAnalyzeServiceError } from './errors.js';

const requiredText = z.string().trim().min(1).max(6000);
export const companyQuestionContextSchema = z.object({
  enterprise_name: z.string().trim().max(200).nullable(),
  business_summary: requiredText,
  company_objective: requiredText,
  analytics_goal: requiredText,
  main_products_or_services: z.array(z.string().trim().max(200)).max(50).nullable(),
}).strict();

const questionSchema = z.object({
  question_order: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  question_text: z.string().trim().min(20).max(150)
    .regex(/^[^?]+\?$/)
    .refine(text => !Array.from(text).some(char => char.charCodeAt(0) < 32)),
}).strict();

export const companyQuestionResponseSchema = z.object({
  questions: z.tuple([questionSchema, questionSchema, questionSchema]),
}).strict().refine(({ questions }) => {
  const normalized = questions.map(q => q.question_text.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' '));
  return questions.every((q, i) => q.question_order === i + 1) && new Set(normalized).size === 3;
});

export function parseCompanyQuestionResponse(value: unknown): CompanyQuestionSuggestionsRemoteResponse {
  const parsed = companyQuestionResponseSchema.safeParse(value);
  if (!parsed.success) throw new IaAnalyzeServiceError('invalid_question_suggestions', 502, 'invalid_ai_response_schema');
  return parsed.data;
}

export function companyQuestionContextHash(context: z.infer<typeof companyQuestionContextSchema>): string {
  return createHash('sha256').update(JSON.stringify(context)).digest('hex');
}
