/**
 * Repositório da FILA de análise assíncrona (etapa 03). A tabela `ia_analysis_job`
 * é ao mesmo tempo a fila e o status de progresso.
 *
 * Isolamento multi-tenant: SEMPRE via `scopedByEnterprise` (a role do Drizzle
 * IGNORA a RLS — ver tenantScope). Dedup de duplo-clique: o índice PARCIAL ÚNICO
 * `uq_ia_analysis_job_active` garante no máximo 1 job ATIVO por
 * (enterprise, job_type, scope_type, catalog_item_id); aqui fazemos o
 * "select-antes-de-inserir" e usamos a violação de unique (23505) como backstop
 * contra a corrida do duplo-clique concorrente.
 *
 * As funções de consumo do worker (claimNext/updateProgress/complete/...) entram
 * na etapa 03.3 (drain).
 */
import { desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { iaAnalysisJob } from '../../drizzle/schema.js';
import { scopedByEnterprise } from '../db/tenantScope.js';

export type IaJobType = 'analyze_raw' | 'regenerate_insights';

/** Status que contam como "job em aberto" (participam do dedup). */
export const ACTIVE_IA_JOB_STATUSES = ['queued', 'running', 'waiting_budget'] as const;

export type EnqueueIaJobParams = {
  enterpriseId: string;
  jobType: IaJobType;
  scopeType?: string;
  catalogItemId?: string | null;
  requestedBy?: string | null;
  /** Knobs de execução que não viram coluna (ex.: limit, force). */
  options?: Record<string, unknown>;
};

export type EnqueuedJob = { jobId: string; status: string; deduped: boolean };

export type IaJobStatus = {
  id: string;
  jobType: string;
  scopeType: string;
  catalogItemId: string | null;
  status: string;
  total: number;
  done: number;
  errorCode: string | null;
  updatedAt: string | null;
};

type ActiveKey = {
  enterpriseId: string;
  jobType: IaJobType;
  scopeType: string;
  catalogItemId: string | null;
};

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
}

/** Job ATIVO já existente para o mesmo escopo (base do dedup), ou null. */
async function selectActiveJob(key: ActiveKey): Promise<{ id: string; status: string } | null> {
  const rows = await getDb()
    .select({ id: iaAnalysisJob.id, status: iaAnalysisJob.status })
    .from(iaAnalysisJob)
    .where(
      scopedByEnterprise(
        iaAnalysisJob.enterpriseId,
        key.enterpriseId,
        eq(iaAnalysisJob.jobType, key.jobType),
        key.catalogItemId === null
          ? isNull(iaAnalysisJob.catalogItemId)
          : eq(iaAnalysisJob.catalogItemId, key.catalogItemId),
        eq(iaAnalysisJob.scopeType, key.scopeType),
        inArray(iaAnalysisJob.status, ACTIVE_IA_JOB_STATUSES as unknown as string[]),
      ),
    )
    .orderBy(desc(iaAnalysisJob.createdAt))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Enfileira um job. Idempotente por escopo: se já há um job ATIVO para o mesmo
 * (enterprise, job_type, scope_type, catalog_item_id), devolve-o (`deduped:true`)
 * em vez de criar outro — resolve duplo-clique e "clica de novo porque travou".
 */
export async function enqueueIaJob(params: EnqueueIaJobParams): Promise<EnqueuedJob> {
  const key: ActiveKey = {
    enterpriseId: params.enterpriseId,
    jobType: params.jobType,
    scopeType: params.scopeType ?? 'COMPANY',
    catalogItemId: params.catalogItemId ?? null,
  };

  const existing = await selectActiveJob(key);
  if (existing) {
    return { jobId: existing.id, status: existing.status, deduped: true };
  }

  try {
    const [row] = await getDb()
      .insert(iaAnalysisJob)
      .values({
        enterpriseId: key.enterpriseId,
        jobType: key.jobType,
        scopeType: key.scopeType,
        catalogItemId: key.catalogItemId,
        requestedBy: params.requestedBy ?? null,
        options: params.options ?? {},
        status: 'queued',
      })
      .returning({ id: iaAnalysisJob.id, status: iaAnalysisJob.status });

    return { jobId: row.id, status: row.status, deduped: false };
  } catch (error) {
    // Corrida do duplo-clique: o índice parcial único barrou o 2º INSERT — relê o ativo.
    if (isUniqueViolation(error)) {
      const again = await selectActiveJob(key);
      if (again) return { jobId: again.id, status: again.status, deduped: true };
    }
    throw error;
  }
}

/** Status de um job, escopado por empresa (para o polling). `null` se não existe/não é do tenant. */
export async function getIaJobByIdScoped(params: {
  enterpriseId: string;
  jobId: string;
}): Promise<IaJobStatus | null> {
  const rows = await getDb()
    .select({
      id: iaAnalysisJob.id,
      jobType: iaAnalysisJob.jobType,
      scopeType: iaAnalysisJob.scopeType,
      catalogItemId: iaAnalysisJob.catalogItemId,
      status: iaAnalysisJob.status,
      total: iaAnalysisJob.total,
      done: iaAnalysisJob.done,
      errorCode: iaAnalysisJob.errorCode,
      updatedAt: iaAnalysisJob.updatedAt,
    })
    .from(iaAnalysisJob)
    .where(
      scopedByEnterprise(iaAnalysisJob.enterpriseId, params.enterpriseId, eq(iaAnalysisJob.id, params.jobId)),
    )
    .limit(1);

  return rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Consumo pelo worker/drain (etapa 03.3).
// ─────────────────────────────────────────────────────────────────────────────

export type ClaimedIaJob = {
  id: string;
  enterpriseId: string;
  jobType: string;
  scopeType: string;
  catalogItemId: string | null;
  options: Record<string, unknown>;
  total: number;
  done: number;
  attempts: number;
};

/**
 * Puxa o próximo job "pronto" (queued/waiting_budget com next_run_at vencido) e o
 * marca como `running`, ATOMICAMENTE, com `FOR UPDATE SKIP LOCKED`: dois
 * ticks/workers concorrentes nunca pegam o mesmo job. Retorna null se não há
 * trabalho disponível.
 */
export async function claimNextIaJob(): Promise<ClaimedIaJob | null> {
  const rows = (await getDb().execute(sql`
    UPDATE ia_analysis_job
    SET status = 'running', updated_at = now()
    WHERE id = (
      SELECT id FROM ia_analysis_job
      WHERE status IN ('queued', 'waiting_budget') AND next_run_at <= now()
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, enterprise_id, job_type, scope_type, catalog_item_id, options, total, done, attempts
  `)) as unknown as Array<{
    id: string;
    enterprise_id: string;
    job_type: string;
    scope_type: string;
    catalog_item_id: string | null;
    options: Record<string, unknown> | null;
    total: number;
    done: number;
    attempts: number;
  }>;

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    enterpriseId: row.enterprise_id,
    jobType: row.job_type,
    scopeType: row.scope_type,
    catalogItemId: row.catalog_item_id,
    options: row.options ?? {},
    total: Number(row.total),
    done: Number(row.done),
    attempts: Number(row.attempts),
  };
}

/** Define o total de passos do job (uma vez, no início do processamento). */
export async function setIaJobTotal(jobId: string, total: number): Promise<void> {
  await getDb().update(iaAnalysisJob).set({ total }).where(eq(iaAnalysisJob.id, jobId));
}

/** Atualiza o progresso (passos concluídos) para o polling. */
export async function updateIaJobDone(jobId: string, done: number): Promise<void> {
  await getDb().update(iaAnalysisJob).set({ done }).where(eq(iaAnalysisJob.id, jobId));
}

/** Marca o job como concluído. */
export async function completeIaJob(
  jobId: string,
  progress: { total: number; done: number },
): Promise<void> {
  await getDb()
    .update(iaAnalysisJob)
    .set({ status: 'completed', total: progress.total, done: progress.done, errorCode: null })
    .where(eq(iaAnalysisJob.id, jobId));
}

/** Marca o job como falho, com o código de erro tipado. */
export async function failIaJob(jobId: string, errorCode: string): Promise<void> {
  await getDb()
    .update(iaAnalysisJob)
    .set({ status: 'failed', errorCode, attempts: sql`${iaAnalysisJob.attempts} + 1` })
    .where(eq(iaAnalysisJob.id, jobId));
}

/**
 * Devolve o job à fila para CONTINUAR no próximo tick (orçamento de lotes do tick
 * esgotado). Preserva `done`; volta para 'queued' com next_run_at = agora.
 */
export async function requeueIaJob(jobId: string): Promise<void> {
  await getDb()
    .update(iaAnalysisJob)
    .set({ status: 'queued', nextRunAt: sql`now()`, attempts: sql`${iaAnalysisJob.attempts} + 1` })
    .where(eq(iaAnalysisJob.id, jobId));
}

/**
 * Back-pressure do rate limiter: sem orçamento de IA, o job espera a próxima
 * janela (`waiting_budget`, `next_run_at` = início da próxima janela). NÃO conta
 * como falha nem tentativa — o ritmo é ditado pelo orçamento, não pelos cliques.
 */
export async function rescheduleForBudget(jobId: string, reason: 'minute' | 'day'): Promise<void> {
  const nextRunAt =
    reason === 'day'
      ? sql`date_trunc('day', now()) + interval '1 day'`
      : sql`date_trunc('minute', now()) + interval '1 minute'`;

  await getDb()
    .update(iaAnalysisJob)
    .set({ status: 'waiting_budget', nextRunAt })
    .where(eq(iaAnalysisJob.id, jobId));
}

