import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../../index.js';
import { resolveEnterpriseIdByUser } from '../repositories/enterprise.repository.js';
import { enqueueIaJob, getIaJobByIdScoped, listActiveIaJobsScoped } from '../repositories/iaJob.repository.js';
import { drainJobs } from '../libs/iaJob/drainJobs.js';

const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';
const ENT = 'ent-1';
const JOB_ID = '22222222-2222-2222-2222-222222222222';

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
vi.mock('../repositories/iaJob.repository.js', () => ({
  enqueueIaJob: vi.fn(),
  getIaJobByIdScoped: vi.fn(),
  listActiveIaJobsScoped: vi.fn(),
}));
vi.mock('../libs/iaJob/drainJobs.js', () => ({ drainJobs: vi.fn() }));

const mEnqueue = vi.mocked(enqueueIaJob);
const mGetJob = vi.mocked(getIaJobByIdScoped);
const mDrain = vi.mocked(drainJobs);
const mResolveEnt = vi.mocked(resolveEnterpriseIdByUser);

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = { id: TEST_USER_ID };
  mResolveEnt.mockResolvedValue(ENT);
});

describe('[Integração] enqueue sempre assíncrono (ignora flag legada)', () => {
  beforeEach(() => {
    process.env.IA_ASYNC_ENABLED = 'false';
  });
  afterEach(() => {
    delete process.env.IA_ASYNC_ENABLED;
  });

  it('analyze-raw enfileira e responde 202 { jobId }', async () => {
    mEnqueue.mockResolvedValueOnce({ jobId: JOB_ID, status: 'queued', deduped: false });

    const res = await request(app)
      .post('/api/protected/ia-analyze/analyze-raw')
      .send({ scope_type: 'COMPANY', analyze_pending: true });

    expect(res.status).toBe(202);
    expect(res.body.jobId).toBe(JOB_ID);
    expect(mEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ enterpriseId: ENT, jobType: 'analyze_raw' }),
    );
  });

  it('regenerate-insights enfileira com jobType correto', async () => {
    mEnqueue.mockResolvedValueOnce({ jobId: JOB_ID, status: 'queued', deduped: false });

    const res = await request(app)
      .post('/api/protected/ia-analyze/regenerate-insights')
      .send({ scope_type: 'COMPANY' });

    expect(res.status).toBe(202);
    expect(mEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ jobType: 'regenerate_insights' }),
    );
  });
});

describe('[Integração] GET /api/protected/ia-analyze/jobs/:id (polling)', () => {
  it('recupera jobs ativos exclusivamente da empresa autenticada', async () => {
    vi.mocked(listActiveIaJobsScoped).mockResolvedValue([]);
    const res = await request(app).get('/api/protected/ia-analyze/jobs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ jobs: [] });
    expect(listActiveIaJobsScoped).toHaveBeenCalledWith(ENT);
  });
  it('retorna 200 com o status do job', async () => {
    mGetJob.mockResolvedValueOnce({
      id: JOB_ID,
      jobType: 'analyze_raw',
      scopeType: 'COMPANY',
      catalogItemId: null,
      status: 'running',
      total: 10,
      done: 4,
      errorCode: null,
      updatedAt: null,
    });

    const res = await request(app).get(`/api/protected/ia-analyze/jobs/${JOB_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'running', done: 4, total: 10 });
  });

  it('retorna 404 quando o job não é do tenant (isolamento)', async () => {
    mGetJob.mockResolvedValueOnce(null);
    const res = await request(app).get(`/api/protected/ia-analyze/jobs/${JOB_ID}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ia_job_not_found');
  });

  it('retorna 404 para id não-uuid, sem tocar o banco', async () => {
    const res = await request(app).get('/api/protected/ia-analyze/jobs/not-a-uuid');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ia_job_not_found');
    expect(mGetJob).not.toHaveBeenCalled();
  });

  it('401 sem autenticação', async () => {
    authState.user = null;
    const res = await request(app).get(`/api/protected/ia-analyze/jobs/${JOB_ID}`);
    expect(res.status).toBe(401);
  });
});

describe('[Integração] POST /api/internal/worker/tick', () => {
  afterEach(() => {
    delete process.env.WORKER_TICK_TOKEN;
    process.env.VERCEL = '1';
  });

  it('sem WORKER_TICK_TOKEN configurado → liberado (dev) e drena', async () => {
    process.env.VERCEL = '0';
    delete process.env.WORKER_TICK_TOKEN;
    mDrain.mockResolvedValueOnce({ processed: 2, results: [] });

    const res = await request(app).post('/api/internal/worker/tick');

    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(2);
    expect(mDrain).toHaveBeenCalled();
  });

  it('Vercel recusa tick sem token configurado', async () => {
    delete process.env.WORKER_TICK_TOKEN;
    const res = await request(app).post('/api/internal/worker/tick');
    expect(res.status).toBe(401);
    expect(mDrain).not.toHaveBeenCalled();
  });

  it('com token configurado → 401 sem o header', async () => {
    process.env.WORKER_TICK_TOKEN = 'secret';
    const res = await request(app).post('/api/internal/worker/tick');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized_worker_request');
    expect(mDrain).not.toHaveBeenCalled();
  });

  it('com token configurado → 200 com o header correto', async () => {
    process.env.WORKER_TICK_TOKEN = 'secret';
    mDrain.mockResolvedValueOnce({ processed: 0, results: [] });

    const res = await request(app)
      .post('/api/internal/worker/tick')
      .set('x-worker-token', 'secret');

    expect(res.status).toBe(200);
  });
});
