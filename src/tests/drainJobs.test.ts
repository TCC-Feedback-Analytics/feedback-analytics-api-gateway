import { vi, describe, it, expect, beforeEach } from 'vitest';
import { IaAnalyzeServiceError } from '../libs/iaAnalyze/errors.js';
import type { ClaimedIaJob } from '../repositories/iaJob.repository.js';

// Testa a MÁQUINA DE ESTADOS do drain isoladamente: repo, serviço e rate budget
// são mockados, então validamos só a orquestração (o que é chamado e com quê).
vi.mock('../repositories/iaJob.repository.js', () => ({
  claimNextIaJob: vi.fn(),
  completeIaJob: vi.fn(),
  failIaJob: vi.fn(),
  requeueIaJob: vi.fn(),
  rescheduleForBudget: vi.fn(),
  setIaJobTotal: vi.fn(),
  updateIaJobDone: vi.fn(),
}));
vi.mock('../services/iaAnalyze.service.js', () => ({
  prepareAnalyzeRawJob: vi.fn(),
  runOneBatch: vi.fn(),
  regenerateFeedbackInsights: vi.fn(),
}));
vi.mock('../libs/iaJob/rateBudget.js', () => ({ reserveIaBudget: vi.fn() }));
vi.mock('../libs/iaJob/config.js', () => ({ readBatchesPerTick: vi.fn(() => 10) }));

import { drainJobs } from '../libs/iaJob/drainJobs.js';
import {
  claimNextIaJob,
  completeIaJob,
  failIaJob,
  requeueIaJob,
  rescheduleForBudget,
  setIaJobTotal,
  updateIaJobDone,
} from '../repositories/iaJob.repository.js';
import {
  prepareAnalyzeRawJob,
  runOneBatch,
  regenerateFeedbackInsights,
} from '../services/iaAnalyze.service.js';
import { reserveIaBudget } from '../libs/iaJob/rateBudget.js';

const mClaim = vi.mocked(claimNextIaJob);
const mPrepare = vi.mocked(prepareAnalyzeRawJob);
const mReserve = vi.mocked(reserveIaBudget);

function job(over: Partial<ClaimedIaJob> = {}): ClaimedIaJob {
  return {
    id: 'job-1',
    enterpriseId: 'ent-1',
    jobType: 'analyze_raw',
    scopeType: 'COMPANY',
    catalogItemId: null,
    options: {},
    total: 0,
    done: 0,
    attempts: 0,
    ...over,
  };
}

type Prepared = NonNullable<Awaited<ReturnType<typeof prepareAnalyzeRawJob>>>;
function prepared(batchSizes: number[]): Prepared {
  return {
    enterpriseContext: {} as Prepared['enterpriseContext'],
    batches: batchSizes.map((n) => ({
      scopeType: 'COMPANY',
      catalogItemId: null,
      catalogItemName: null,
      feedbacks: Array.from({ length: n }, (_, i) => ({ id: `f${i}` })),
    })) as Prepared['batches'],
    allowedFeedbackIds: new Set<string>(),
  };
}

// Só um job por drain: retorna o job uma vez e depois esvazia a fila.
function claimOnce(j: ClaimedIaJob) {
  mClaim.mockResolvedValueOnce(j).mockResolvedValue(null);
}

beforeEach(() => {
  vi.clearAllMocks();
  mReserve.mockResolvedValue({ ok: true });
});

describe('drainJobs — máquina de estados', () => {
  it('fila vazia → processed 0, sem efeitos', async () => {
    mClaim.mockResolvedValue(null);
    const r = await drainJobs();
    expect(r).toEqual({ processed: 0, results: [] });
  });

  it('analyze_raw: processa todos os lotes e conclui', async () => {
    claimOnce(job());
    mPrepare.mockResolvedValue(prepared([3, 3]));

    const r = await drainJobs({ maxBatches: 10 });

    expect(setIaJobTotal).toHaveBeenCalledWith('job-1', 6);
    expect(runOneBatch).toHaveBeenCalledTimes(2);
    expect(updateIaJobDone).toHaveBeenNthCalledWith(1, 'job-1', 3);
    expect(updateIaJobDone).toHaveBeenNthCalledWith(2, 'job-1', 6);
    expect(completeIaJob).toHaveBeenCalledWith('job-1', { total: 6, done: 6 });
    expect(r.results[0].status).toBe('completed');
  });

  it('orçamento do TICK esgotado → re-enfileira (requeued), sem concluir', async () => {
    claimOnce(job());
    mPrepare.mockResolvedValue(prepared([3, 3]));

    const r = await drainJobs({ maxBatches: 1 });

    expect(runOneBatch).toHaveBeenCalledTimes(1);
    expect(requeueIaJob).toHaveBeenCalledWith('job-1');
    expect(completeIaJob).not.toHaveBeenCalled();
    expect(r.results[0].status).toBe('requeued');
  });

  it('orçamento de IA (rate limit) esgotado → waiting_budget (rescheduled), sem chamar o LLM', async () => {
    mReserve.mockResolvedValue({ ok: false, reason: 'minute' });
    claimOnce(job());
    mPrepare.mockResolvedValue(prepared([3]));

    const r = await drainJobs({ maxBatches: 5 });

    expect(rescheduleForBudget).toHaveBeenCalledWith('job-1', 'minute');
    expect(runOneBatch).not.toHaveBeenCalled();
    expect(r.results[0].status).toBe('rescheduled');
  });

  it('validação falha no preparo (422) → job failed com o errorCode', async () => {
    claimOnce(job());
    mPrepare.mockRejectedValue(
      new IaAnalyzeServiceError('x', 422, 'insufficient_feedbacks_for_analysis'),
    );

    const r = await drainJobs();

    expect(failIaJob).toHaveBeenCalledWith('job-1', 'insufficient_feedbacks_for_analysis');
    expect(r.results[0].status).toBe('failed');
    expect(r.results[0].errorCode).toBe('insufficient_feedbacks_for_analysis');
  });

  it('nada novo a analisar (prep null) → conclui com done = total', async () => {
    claimOnce(job({ total: 4 }));
    mPrepare.mockResolvedValue(null);

    const r = await drainJobs();

    expect(completeIaJob).toHaveBeenCalledWith('job-1', { total: 4, done: 4 });
    expect(r.results[0].status).toBe('completed');
  });

  it('regenerate_insights: reserva orçamento, gera e conclui', async () => {
    claimOnce(job({ jobType: 'regenerate_insights' }));

    const r = await drainJobs();

    expect(reserveIaBudget).toHaveBeenCalled();
    expect(regenerateFeedbackInsights).toHaveBeenCalledWith(
      expect.objectContaining({ enterpriseId: 'ent-1' }),
    );
    expect(completeIaJob).toHaveBeenCalledWith('job-1', { total: 1, done: 1 });
    expect(r.results[0].status).toBe('completed');
  });
});
