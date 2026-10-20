import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../index.js';
import { IaAnalyzeServiceError } from '../libs/iaAnalyze/errors.js';
import { resolveEnterpriseIdByUser } from '../repositories/enterprise.repository.js';
import { getIaJobByIdScoped, listActiveIaJobsForTypeScoped } from '../repositories/iaJob.repository.js';
import {
  fetchLatestScopeDiagnosis,
  fetchScopeDiagnosisById,
  listScopeDiagnoses,
} from '../repositories/scopeDiagnosis.repository.js';
import { requestScopeDiagnosis, toScopeDiagnosis } from '../services/scopeDiagnosis.service.js';

const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';
const TEST_ENTERPRISE_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const ITEM_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const DIAGNOSIS_ID = 'cccccccc-0000-0000-0000-000000000003';

vi.mock('../middlewares/auth.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: TEST_USER_ID };
    next();
  },
}));
vi.mock('../repositories/enterprise.repository.js', () => ({ resolveEnterpriseIdByUser: vi.fn() }));
vi.mock('../repositories/iaJob.repository.js', () => ({
  getIaJobByIdScoped: vi.fn(), listActiveIaJobsForTypeScoped: vi.fn(),
  ACTIVE_IA_JOB_STATUSES: ['queued', 'running', 'waiting_budget'],
}));
vi.mock('../repositories/scopeDiagnosis.repository.js', () => ({
  fetchLatestScopeDiagnosis: vi.fn(), fetchScopeDiagnosisById: vi.fn(), listScopeDiagnoses: vi.fn(),
}));
vi.mock('../services/scopeDiagnosis.service.js', () => ({ requestScopeDiagnosis: vi.fn(), toScopeDiagnosis: vi.fn() }));

const ROW = {
  id: DIAGNOSIS_ID, scopeType: 'COMPANY', catalogItemId: null,
  periodStart: '2026-09-01 03:00:00+00', periodEnd: '2026-10-01 03:00:00+00', previousStart: null, previousEnd: null,
  feedbackCount: 14, model: 'modelo/teste', createdAt: '2026-10-02 12:00:00+00',
  result: { summary: 'Resumo do período.', going_well: [], concerns: [], changes: [], recommendations: [], limitations: [] },
};

describe('[Integração] diagnóstico do escopo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveEnterpriseIdByUser).mockResolvedValue(TEST_ENTERPRISE_ID);
    vi.mocked(listActiveIaJobsForTypeScoped).mockResolvedValue([]);
  });

  describe('POST /protected/ia-analyze/scope-diagnosis', () => {
    const ROUTE = '/api/protected/ia-analyze/scope-diagnosis';

    it('202 com o job e os parâmetros lidos do corpo', async () => {
      vi.mocked(requestScopeDiagnosis).mockResolvedValue({ jobId: 'job-1', status: 'queued', deduped: false, cached: false, diagnosisId: null });
      const res = await request(app).post(ROUTE).send({
        scope_type: 'product', catalog_item_id: ITEM_ID,
        start_date: '2026-09-01T03:00:00.000Z', end_date: '2026-10-01T03:00:00.000Z', tz: 'America/Sao_Paulo',
      });
      expect(res.status).toBe(202);
      expect(res.body.jobId).toBe('job-1');
      expect(requestScopeDiagnosis).toHaveBeenCalledWith({
        enterpriseId: TEST_ENTERPRISE_ID, userId: TEST_USER_ID, scopeType: 'PRODUCT', catalogItemId: ITEM_ID,
        period: { start: '2026-09-01T03:00:00.000Z', end: '2026-10-01T03:00:00.000Z' }, timeZone: 'America/Sao_Paulo', force: false,
      });
    });

    it('200 quando já existe diagnóstico com os mesmos dados', async () => {
      vi.mocked(requestScopeDiagnosis).mockResolvedValue({ jobId: null, status: 'completed', deduped: false, cached: true, diagnosisId: DIAGNOSIS_ID });
      const res = await request(app).post(ROUTE).send({ scope_type: 'COMPANY' });
      expect(res.status).toBe(200);
      expect(res.body.cached).toBe(true);
    });

    it('400 com período, fuso, item ou escopo inválidos', async () => {
      for (const body of [
        { scope_type: 'COMPANY', start_date: 'ontem' },
        { scope_type: 'COMPANY', start_date: '2026-10-01', end_date: '2026-09-01' },
        { scope_type: 'COMPANY', tz: 'Lugar/Nenhum' },
        { scope_type: 'PRODUCT', catalog_item_id: 'nao-e-uuid' },
        { scope_type: 'COMPANY', catalog_item_id: ITEM_ID },
        { scope_type: 'TUDO' },
      ]) {
        const res = await request(app).post(ROUTE).send(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      expect(requestScopeDiagnosis).not.toHaveBeenCalled();
    });

    it('repassa o erro tipado do serviço', async () => {
      vi.mocked(requestScopeDiagnosis).mockRejectedValue(new IaAnalyzeServiceError('poucos', 422, 'insufficient_feedbacks_for_analysis'));
      const res = await request(app).post(ROUTE).send({ scope_type: 'COMPANY' });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('insufficient_feedbacks_for_analysis');
    });
  });

  describe('GET /protected/ia-analyze/scope-diagnosis/latest', () => {
    it('devolve o último diagnóstico e o job em andamento do mesmo escopo', async () => {
      vi.mocked(fetchLatestScopeDiagnosis).mockResolvedValue(ROW as never);
      vi.mocked(toScopeDiagnosis).mockResolvedValue({ id: DIAGNOSIS_ID, newFeedbacksSince: 2 } as never);
      vi.mocked(listActiveIaJobsForTypeScoped).mockResolvedValue([
        { id: 'job-outro', scopeType: 'PRODUCT', catalogItemId: ITEM_ID },
        { id: 'job-1', scopeType: 'COMPANY', catalogItemId: null },
      ]);
      vi.mocked(getIaJobByIdScoped).mockResolvedValue({ id: 'job-1', status: 'running' } as never);

      const res = await request(app).get('/api/protected/ia-analyze/scope-diagnosis/latest?scope_type=COMPANY');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ diagnosis: { id: DIAGNOSIS_ID, newFeedbacksSince: 2 }, job: { id: 'job-1', status: 'running' } });
      expect(fetchLatestScopeDiagnosis).toHaveBeenCalledWith({ enterpriseId: TEST_ENTERPRISE_ID, scopeType: 'COMPANY', catalogItemId: null });
      expect(getIaJobByIdScoped).toHaveBeenCalledWith({ enterpriseId: TEST_ENTERPRISE_ID, jobId: 'job-1' });
    });

    it('sem diagnóstico nem job, devolve os dois nulos', async () => {
      vi.mocked(fetchLatestScopeDiagnosis).mockResolvedValue(null);
      const res = await request(app).get('/api/protected/ia-analyze/scope-diagnosis/latest');
      expect(res.body).toEqual({ diagnosis: null, job: null });
    });
  });

  it('GET /protected/ia-analyze/scope-diagnosis lista o histórico só com o resumo', async () => {
    vi.mocked(listScopeDiagnoses).mockResolvedValue([ROW] as never);
    const res = await request(app).get('/api/protected/ia-analyze/scope-diagnosis?scope_type=COMPANY');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([{
      id: DIAGNOSIS_ID, period: { start: '2026-09-01T03:00:00.000Z', end: '2026-10-01T03:00:00.000Z' },
      feedbackCount: 14, model: 'modelo/teste', createdAt: '2026-10-02T12:00:00.000Z', summary: 'Resumo do período.',
    }]);
  });

  describe('GET /protected/ia-analyze/scope-diagnosis/:id', () => {
    it('404 com id inválido ou de outra empresa', async () => {
      expect((await request(app).get('/api/protected/ia-analyze/scope-diagnosis/abc')).status).toBe(404);
      vi.mocked(fetchScopeDiagnosisById).mockResolvedValue(null);
      const res = await request(app).get(`/api/protected/ia-analyze/scope-diagnosis/${DIAGNOSIS_ID}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('scope_diagnosis_not_found');
      expect(fetchScopeDiagnosisById).toHaveBeenCalledWith(TEST_ENTERPRISE_ID, DIAGNOSIS_ID);
    });

    it('200 com o diagnóstico completo', async () => {
      vi.mocked(fetchScopeDiagnosisById).mockResolvedValue(ROW as never);
      vi.mocked(toScopeDiagnosis).mockResolvedValue({ id: DIAGNOSIS_ID } as never);
      const res = await request(app).get(`/api/protected/ia-analyze/scope-diagnosis/${DIAGNOSIS_ID}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(DIAGNOSIS_ID);
    });
  });
});
