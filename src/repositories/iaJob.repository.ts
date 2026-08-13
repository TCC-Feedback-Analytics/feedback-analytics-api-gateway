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
import { desc, eq, inArray, isNull } from 'drizzle-orm';
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
