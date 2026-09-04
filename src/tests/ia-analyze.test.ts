import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../index.js';
import { enqueueIaJob } from '../repositories/iaJob.repository.js';
import { analyzeRawFeedbacks, regenerateFeedbackInsights } from '../services/iaAnalyze.service.js';
import { resolveEnterpriseIdByUser } from '../repositories/enterprise.repository.js';
const { authState } = vi.hoisted(() => ({ authState: { user: { id: 'user-A' } as { id: string } | null } }));
vi.mock('../middlewares/auth.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requireAuth: (req: any, res: any, next: any) => {
    if (!authState.user) return res.status(401).json({ error: 'unauthorized' });
    req.user = authState.user; next();
  },
}));
vi.mock('../repositories/iaJob.repository.js', () => ({ enqueueIaJob: vi.fn() }));
vi.mock('../services/iaAnalyze.service.js', () => ({ analyzeRawFeedbacks: vi.fn(), regenerateFeedbackInsights: vi.fn() }));
vi.mock('../repositories/enterprise.repository.js', () => ({ resolveEnterpriseIdByUser: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  authState.user = { id: 'user-A' };
  delete process.env.IA_ASYNC_ENABLED;
  vi.mocked(resolveEnterpriseIdByUser).mockResolvedValue('tenant-A');
  vi.mocked(enqueueIaJob).mockResolvedValue({ jobId: 'job-A', status: 'queued', deduped: false });
});
describe.each(['analyze-raw', 'regenerate-insights'])('POST %s: sempre fila', endpoint => {
  it('sem flag retorna 202 e não chama o serviço de IA', async () => {
    const res = await request(app).post('/api/protected/ia-analyze/' + endpoint).send({ scope_type: 'COMPANY', analyze_pending: true });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ jobId: 'job-A', status: 'queued' });
    expect(analyzeRawFeedbacks).not.toHaveBeenCalled();
    expect(regenerateFeedbackInsights).not.toHaveBeenCalled();
    if (endpoint === 'regenerate-insights') expect(enqueueIaJob).toHaveBeenCalledWith(expect.objectContaining({ options: { force: false, analyzePending: true } }));
  });
  it('401 sem sessão', async () => {
    authState.user = null;
    expect((await request(app).post('/api/protected/ia-analyze/' + endpoint).send({})).status).toBe(401);
    expect(enqueueIaJob).not.toHaveBeenCalled();
  });
  it('404 sem empresa', async () => {
    vi.mocked(resolveEnterpriseIdByUser).mockResolvedValue(null);
    expect((await request(app).post('/api/protected/ia-analyze/' + endpoint).send({})).status).toBe(404);
    expect(enqueueIaJob).not.toHaveBeenCalled();
  });
  it('falha de fila não tenta executar IA como fallback', async () => {
    vi.mocked(enqueueIaJob).mockRejectedValue(new Error('queue unavailable'));
    const res = await request(app).post('/api/protected/ia-analyze/' + endpoint).send({});
    expect(res.status).toBe(500);
    expect(analyzeRawFeedbacks).not.toHaveBeenCalled();
    expect(regenerateFeedbackInsights).not.toHaveBeenCalled();
  });
});
