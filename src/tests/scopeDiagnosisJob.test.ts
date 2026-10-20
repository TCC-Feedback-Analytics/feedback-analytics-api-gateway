import { vi, describe, it, expect, beforeEach } from 'vitest';
import { IaAnalyzeServiceError } from '../libs/iaAnalyze/errors.js';
import { drainJobs } from '../libs/iaJob/drainJobs.js';
import { claimNextIaJob, saveClaimedIaJob, type ClaimedIaJob } from '../repositories/iaJob.repository.js';
import { executeScopeDiagnosisJob } from '../services/scopeDiagnosis.service.js';
import { resolveCompanyQuestionCreds } from '../services/companyQuestionSuggestions.service.js';
import { reserveIaBudget } from '../libs/iaJob/rateBudget.js';

vi.mock('../repositories/iaJob.repository.js', () => ({
  claimNextIaJob: vi.fn(), saveClaimedIaJob: vi.fn(), IaJobLeaseLostError: class extends Error {},
}));
vi.mock('../services/scopeDiagnosis.service.js', async importOriginal => ({
  ...await importOriginal<typeof import('../services/scopeDiagnosis.service.js')>(),
  executeScopeDiagnosisJob: vi.fn(),
}));
vi.mock('../services/companyQuestionSuggestions.service.js', () => ({ resolveCompanyQuestionCreds: vi.fn() }));
vi.mock('../libs/iaJob/rateBudget.js', () => ({ reserveIaBudget: vi.fn() }));

const CREDS = { provider: 'openrouter', apiKey: 'test-only-key', model: 'modelo/teste' };
let saved: ClaimedIaJob & { status: string; errorCode?: string | null };

async function tick() {
  vi.mocked(claimNextIaJob).mockResolvedValueOnce(structuredClone(saved));
  return (await drainJobs({ maxBatches: 1 })).results[0];
}

beforeEach(() => {
  vi.resetAllMocks();
  saved = {
    id: 'job-1', enterpriseId: 'tenant-A', jobType: 'generate_scope_diagnosis', scopeType: 'COMPANY', catalogItemId: null,
    options: { phase: 'diagnosing', request: { scope: { scope_type: 'COMPANY' }, comment_samples: [{ message: 'texto do cliente' }] }, dataHash: 'hash-1', feedbackCount: 14 },
    done: 0, total: 0, attempts: 1, status: 'running',
  };
  vi.mocked(saveClaimedIaJob).mockImplementation(async (_job, update) => {
    Object.assign(saved, structuredClone(update));
  });
  vi.mocked(resolveCompanyQuestionCreds).mockResolvedValue(CREDS);
  vi.mocked(reserveIaBudget).mockResolvedValue({ ok: true });
});

describe('job do diagnóstico do escopo', () => {
  it('chama a IA uma vez, guarda o id e tira o pacote do job', async () => {
    vi.mocked(executeScopeDiagnosisJob).mockResolvedValue('diag-1');

    expect(await tick()).toMatchObject({ status: 'completed', batchesRun: 1 });
    expect(executeScopeDiagnosisJob).toHaveBeenCalledWith(
      expect.objectContaining({ enterpriseId: 'tenant-A', scopeType: 'COMPANY' }),
      expect.objectContaining({ dataHash: 'hash-1', feedbackCount: 14 }),
      CREDS,
    );
    expect(saved.status).toBe('completed');
    expect(saved.options).toEqual({ phase: 'diagnosing', dataHash: 'hash-1', diagnosisId: 'diag-1' });
  });

  it('sem orçamento, espera sem chamar a IA', async () => {
    vi.mocked(reserveIaBudget).mockResolvedValue({ ok: false, reason: 'minute' });
    expect((await tick()).status).toBe('rescheduled');
    expect(saved.status).toBe('waiting_budget');
    expect(executeScopeDiagnosisJob).not.toHaveBeenCalled();
  });

  it('erro temporário volta para a fila com o pacote', async () => {
    vi.mocked(executeScopeDiagnosisJob).mockRejectedValue(new IaAnalyzeServiceError('limite', 502, 'ia_provider_rate_limited'));
    expect(await tick()).toMatchObject({ status: 'requeued', errorCode: 'ia_provider_rate_limited' });
    expect(saved.status).toBe('queued');
    expect(saved.options.request).toBeDefined();
  });

  it('falha de vez sem guardar os comentários no job', async () => {
    vi.mocked(executeScopeDiagnosisJob).mockRejectedValue(new IaAnalyzeServiceError('schema', 502, 'invalid_ai_response_schema'));
    expect(await tick()).toMatchObject({ status: 'failed', errorCode: 'invalid_ai_response_schema' });
    expect(saved.status).toBe('failed');
    expect(saved.options).toEqual({ dataHash: 'hash-1', phase: 'diagnosing', failures: 1 });
  });

  it('pacote ausente falha sem chamar a IA', async () => {
    saved.options = { phase: 'diagnosing' };
    expect(await tick()).toMatchObject({ status: 'failed', errorCode: 'invalid_scope_diagnosis_job' });
    expect(executeScopeDiagnosisJob).not.toHaveBeenCalled();
  });
});
