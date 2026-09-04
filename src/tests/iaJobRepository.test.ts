import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
const m = vi.hoisted(() => ({ execute: vi.fn(), select: vi.fn(), update: vi.fn(), from: vi.fn(), where: vi.fn(),
  set: vi.fn(), returning: vi.fn(), orderBy: vi.fn(), limit: vi.fn() }));
vi.mock('../db/client.js', () => ({ getDb: () => m }));
import { claimNextIaJob, saveClaimedIaJob, listActiveIaJobsScoped, IaJobLeaseLostError, type ClaimedIaJob } from '../repositories/iaJob.repository.js';
const job: ClaimedIaJob = { id: 'job-A', enterpriseId: 'tenant-A', jobType: 'analyze_raw', scopeType: 'COMPANY',
  catalogItemId: null, options: {}, attempts: 7, done: 0, total: 20 };
const compile = (sql: SQL) => new PgDialect().sqlToQuery(sql);
beforeEach(() => {
  vi.resetAllMocks();
  for (const key of ['select', 'update', 'from', 'set', 'where'] as const) m[key].mockReturnValue(m);
  m.returning.mockResolvedValue([{ id: 'job-A' }]);
});
describe('fila: posse e isolamento SQL', () => {
  it('claim é atômico, recupera running expirado e renova revisão/lease', async () => {
    m.execute.mockResolvedValue([{ id: 'job-A', enterprise_id: 'tenant-A', job_type: 'analyze_raw', scope_type: 'COMPANY',
      catalog_item_id: null, options: {}, total: '20', done: '0', attempts: '7' }]);
    expect(await claimNextIaJob()).toEqual(job);
    const query = compile(m.execute.mock.calls[0][0]).sql;
    expect(query).toContain('FOR UPDATE SKIP LOCKED');
    expect(query).toContain("'queued', 'waiting_budget', 'running'");
    expect(query).toContain('next_run_at <= now()');
    expect(query).toContain('attempts = attempts + 1');
    expect(query).toContain("interval '10 minutes'");
  });
  it('checkpoint exige id + status running + revisão da posse', async () => {
    await saveClaimedIaJob(job, { done: 20 });
    expect(compile(m.where.mock.calls[0][0]).params).toEqual(['job-A', 'running', 7]);
    expect(m.set.mock.calls[0][0]).toMatchObject({ done: 20 });
  });
  it('worker antigo perde direito de concluir/falhar o job', async () => {
    m.returning.mockResolvedValue([]);
    await expect(saveClaimedIaJob(job, { status: 'completed' })).rejects.toBeInstanceOf(IaJobLeaseLostError);
  });
  it('recuperação escopa listagem e consulta; não expõe checkpoint/payload', async () => {
    m.orderBy.mockResolvedValue([{ id: 'job-A' }]);
    m.limit.mockResolvedValue([{ id: 'job-A', status: 'running' }]);
    expect(await listActiveIaJobsScoped('tenant-A')).toEqual([{ id: 'job-A', status: 'running' }]);
    for (const [where] of m.where.mock.calls) expect(compile(where).params).toContain('tenant-A');
    const selected = m.select.mock.calls[1][0];
    expect(selected).not.toHaveProperty('options');
    expect(selected).not.toHaveProperty('checkpoint');
    expect(selected).toHaveProperty('phase');
  });
  it('lista sem tenant é recusada', async () => {
    await expect(listActiveIaJobsScoped('')).rejects.toThrow('enterprise_id');
  });
});
