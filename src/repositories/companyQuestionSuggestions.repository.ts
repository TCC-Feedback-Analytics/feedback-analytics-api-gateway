import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { enterprise, iaAnalysisJob } from '../../drizzle/schema.js';
import { ACTIVE_IA_JOB_STATUSES, getIaJobByIdScoped } from './iaJob.repository.js';
import { IaAnalyzeServiceError } from '../libs/iaAnalyze/errors.js';
import { companyQuestionContextHash, companyQuestionContextSchema, parseCompanyQuestionResponse } from '../libs/iaAnalyze/companyQuestions.js';
import type { z } from 'zod';

export class QuestionSuggestionsRateLimitError extends IaAnalyzeServiceError {
  constructor(public retryAfterSeconds: number) { super('rate_limited', 429, 'rate_limited'); }
}

function positiveEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw?.trim() ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}

export async function enqueueCompanyQuestionSuggestions(params: {
  enterpriseId: string; requestedBy: string; context: z.infer<typeof companyQuestionContextSchema>;
}) {
  const cooldown = positiveEnv('IA_QUESTION_SUGGESTIONS_COOLDOWN_SECONDS', 60);
  const limit = positiveEnv('IA_QUESTION_SUGGESTIONS_MAX_PER_DAY', 5);
  const contextHash = companyQuestionContextHash(params.context);
  return getDb().transaction(async tx => {
    const owner = await tx.select({ id: enterprise.id }).from(enterprise)
      .where(eq(enterprise.id, params.enterpriseId)).for('update');
    if (!owner.length) throw new IaAnalyzeServiceError('enterprise_not_found', 404, 'enterprise_not_found');
    const [active] = await tx.select({ id: iaAnalysisJob.id, status: iaAnalysisJob.status, options: iaAnalysisJob.options })
      .from(iaAnalysisJob).where(and(eq(iaAnalysisJob.enterpriseId, params.enterpriseId),
        eq(iaAnalysisJob.jobType, 'generate_company_questions'),
        inArray(iaAnalysisJob.status, [...ACTIVE_IA_JOB_STATUSES])))
      .orderBy(desc(iaAnalysisJob.createdAt)).limit(1);
    if (active) {
      const options = active.options as { contextHash?: string } | null;
      if (options?.contextHash !== contextHash) {
        throw new IaAnalyzeServiceError('question_generation_context_changed', 409, 'question_generation_context_changed');
      }
      return { jobId: active.id, status: active.status, deduped: true, contextHash };
    }
    const counters = await tx.execute(sql`SELECT count(*) AS used,
      CEIL(EXTRACT(EPOCH FROM (max(created_at) + ${cooldown} * interval '1 second' - now()))) AS cooldown,
      CEIL(EXTRACT(EPOCH FROM (min(created_at) + interval '24 hours' - now()))) AS window_retry
      FROM ia_analysis_job WHERE enterprise_id = ${params.enterpriseId}
      AND job_type = 'generate_company_questions' AND created_at > now() - interval '24 hours'`);
    const count = counters[0] as unknown as { used: string | number; cooldown: string | number | null; window_retry: string | number | null };
    const retry = Math.max(Number(count.cooldown ?? 0), Number(count.used) >= limit ? Number(count.window_retry) : 0);
    if (retry > 0) throw new QuestionSuggestionsRateLimitError(Math.max(1, retry));
    const [job] = await tx.insert(iaAnalysisJob).values({
      enterpriseId: params.enterpriseId, requestedBy: params.requestedBy,
      jobType: 'generate_company_questions', scopeType: 'COMPANY', status: 'queued', total: 1,
      options: { enterpriseContext: params.context, contextHash, phase: 'generating_questions' },
    }).returning({ id: iaAnalysisJob.id, status: iaAnalysisJob.status });
    return { jobId: job.id, status: job.status, deduped: false, contextHash };
  });
}

export async function getCompanyQuestionSuggestions(enterpriseId: string, jobId: string) {
  const job = await getIaJobByIdScoped({ enterpriseId, jobId });
  if (!job || job.jobType !== 'generate_company_questions') return null;
  const [row] = await getDb().select({ options: iaAnalysisJob.options }).from(iaAnalysisJob)
    .where(and(eq(iaAnalysisJob.enterpriseId, enterpriseId), eq(iaAnalysisJob.id, jobId))).limit(1);
  const options = row?.options as { suggestions?: unknown; contextHash?: string } | null;
  if (job.status !== 'completed') return job;
  const contextHash = options?.contextHash;
  if (typeof contextHash !== 'string' || !/^[a-f0-9]{64}$/.test(contextHash)) {
    throw new IaAnalyzeServiceError('invalid_question_generation_job', 502, 'invalid_question_generation_job');
  }
  return { ...job, result: { ...parseCompanyQuestionResponse(options?.suggestions), contextHash } };
}
