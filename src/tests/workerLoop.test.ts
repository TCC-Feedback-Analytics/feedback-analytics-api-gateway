import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startIaWorker } from '../libs/iaJob/workerLoop.js';
import { drainJobs, type DrainResult } from '../libs/iaJob/drainJobs.js';
vi.mock('../libs/iaJob/drainJobs.js', () => ({ drainJobs: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());
describe('worker local automático', () => {
  it('não sobrepõe ticks e para sem novas consultas', async () => {
    let finish!: (result: DrainResult) => void;
    vi.mocked(drainJobs).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const stop = startIaWorker(10);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(drainJobs).toHaveBeenCalledOnce();
    const stopping = stop();
    finish({ processed: 0, results: [] });
    await stopping;
    await vi.advanceTimersByTimeAsync(100_000);
    expect(drainJobs).toHaveBeenCalledOnce();
  });
  it('erro de banco não encerra o loop', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(drainJobs).mockRejectedValueOnce(new Error('private')).mockResolvedValue({ processed: 0, results: [] });
    const stop = startIaWorker(10);
    await vi.advanceTimersByTimeAsync(20);
    expect(drainJobs).toHaveBeenCalledTimes(2);
    await stop();
    vi.restoreAllMocks();
  });
});
