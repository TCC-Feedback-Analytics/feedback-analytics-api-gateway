import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../index.js';
import { resolveEnterpriseIdByUser } from '../repositories/enterprise.repository.js';
import {
  dismissLatestFailedCompanyQuestionsJob,
  getLatestCompanyQuestionsJob,
} from '../repositories/companyQuestionSuggestions.repository.js';
import { hasDefaultCompanyQuestions } from '../repositories/collectingData.repository.js';

const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';
const ENT = 'ent-1';

const { authState } = vi.hoisted(() => ({
  authState: { user: null as { id: string } | null },
}));
vi.mock('../middlewares/auth.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requireAuth: (req: any, res: any, next: any) => {
    if (!authState.user) return res.status(401).json({ error: 'unauthorized' });
    req.user = authState.user;
    next();
  },
}));
vi.mock('../repositories/enterprise.repository.js', () => ({ resolveEnterpriseIdByUser: vi.fn() }));
vi.mock('../repositories/companyQuestionSuggestions.repository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../repositories/companyQuestionSuggestions.repository.js')>();
  return { ...actual, getLatestCompanyQuestionsJob: vi.fn(), dismissLatestFailedCompanyQuestionsJob: vi.fn() };
});
vi.mock('../repositories/collectingData.repository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../repositories/collectingData.repository.js')>();
  return { ...actual, hasDefaultCompanyQuestions: vi.fn() };
});
vi.mock('../libs/iaJob/kickWorker.js', () => ({ kickWorker: vi.fn(), kickWorkerIfPending: vi.fn() }));

const mResolveEnt = vi.mocked(resolveEnterpriseIdByUser);
const mLatest = vi.mocked(getLatestCompanyQuestionsJob);
const mDismiss = vi.mocked(dismissLatestFailedCompanyQuestionsJob);
const mDefault = vi.mocked(hasDefaultCompanyQuestions);

const failedJob = { id: 'job-1', status: 'failed', errorCode: 'invalid_ai_response_schema', applied: null, dismissed: false };

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = { id: TEST_USER_ID };
  mResolveEnt.mockResolvedValue(ENT);
});

describe('[Integração] GET /ia-analyze/jobs/company-questions/latest com stillDefault', () => {
  it('pedido falho com perguntas padrão: diz que o aviso ainda vale', async () => {
    mLatest.mockResolvedValueOnce(failedJob);
    mDefault.mockResolvedValueOnce(true);
    const res = await request(app).get('/api/protected/ia-analyze/jobs/company-questions/latest');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ job: failedJob, stillDefault: true });
    expect(mDefault).toHaveBeenCalledWith(ENT);
  });

  it('perguntas já editadas: stillDefault false', async () => {
    mLatest.mockResolvedValueOnce(failedJob);
    mDefault.mockResolvedValueOnce(false);
    const res = await request(app).get('/api/protected/ia-analyze/jobs/company-questions/latest');
    expect(res.body.stillDefault).toBe(false);
  });

  it('sem pedido nenhum, não consulta as perguntas', async () => {
    mLatest.mockResolvedValueOnce(null);
    const res = await request(app).get('/api/protected/ia-analyze/jobs/company-questions/latest');
    expect(res.body).toEqual({ job: null, stillDefault: null });
    expect(mDefault).not.toHaveBeenCalled();
  });
});

describe('[Integração] POST /ia-analyze/jobs/company-questions/dismiss', () => {
  it('"Manter perguntas padrão" dispensa o aviso do último pedido falho', async () => {
    mDismiss.mockResolvedValueOnce(true);
    const res = await request(app).post('/api/protected/ia-analyze/jobs/company-questions/dismiss');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ dismissed: true });
    expect(mDismiss).toHaveBeenCalledWith(ENT);
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('sem pedido falho, responde dismissed false', async () => {
    mDismiss.mockResolvedValueOnce(false);
    const res = await request(app).post('/api/protected/ia-analyze/jobs/company-questions/dismiss');
    expect(res.body).toEqual({ dismissed: false });
  });

  it('sem empresa, 404; sem login, 401', async () => {
    mResolveEnt.mockResolvedValueOnce(null);
    expect((await request(app).post('/api/protected/ia-analyze/jobs/company-questions/dismiss')).status).toBe(404);
    authState.user = null;
    expect((await request(app).post('/api/protected/ia-analyze/jobs/company-questions/dismiss')).status).toBe(401);
    expect(mDismiss).not.toHaveBeenCalled();
  });
});
