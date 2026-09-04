import { afterEach, describe, expect, it, vi } from 'vitest';
import { runIaAnalyzeAnalysis, runIaInsightsSynthesis } from '../providers/iaAnalyze.provider.js';
import type { IaAnalyzeRemoteRunRequest } from '@feedback/lib-shared/interfaces/contracts/ia-analyze/remote.contract';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Gateway preserva códigos seguros do ia-analyze', () => {
  it('timeout também cobre corpo que não termina após receber os headers', async () => {
    vi.useFakeTimers();
    vi.stubEnv('IA_ANALYZE_EXECUTION_MODE', 'remote');
    vi.stubEnv('IA_ANALYZE_REMOTE_URL', 'http://ia-analyze.test');
    vi.stubEnv('IA_ANALYZE_REMOTE_TIMEOUT_MS', '1000');
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => ({
      ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    })));
    const result = expect(runIaAnalyzeAnalysis({ enterprise_context: {}, batches: [] } as unknown as IaAnalyzeRemoteRunRequest))
      .rejects.toMatchObject({ code: 'failed_remote_ia_analyze_request' });
    await vi.advanceTimersByTimeAsync(1000);
    await result;
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(['empty_ai_response', 'truncated_ai_response', 'incomplete_ai_response', 'invalid_ai_response_schema', 'invalid_ai_response_language', 'ia_provider_credits_exhausted', 'ia_provider_rate_limited'])('%s chega ao controlador sem virar erro genérico', async code => {
    vi.stubEnv('IA_ANALYZE_EXECUTION_MODE', 'remote');
    vi.stubEnv('IA_ANALYZE_REMOTE_URL', 'http://ia-analyze.test');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: code, message: 'Safe error' }), { status: 502 })));
    await expect(runIaAnalyzeAnalysis({ enterprise_context: {}, batches: [] } as unknown as IaAnalyzeRemoteRunRequest)).rejects.toMatchObject({ statusCode: 502, code });
  });

  it('usa o endpoint dedicado de síntese e preserva as credenciais BYO-key', async () => {
    vi.stubEnv('IA_ANALYZE_EXECUTION_MODE', 'remote');
    vi.stubEnv('IA_ANALYZE_REMOTE_URL', 'http://ia-analyze.test');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      global_insights: { summary: 'Resumo final.', recommendations: ['Ação final.'] },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await runIaInsightsSynthesis({
      enterprise_context: {}, scope_type: 'COMPANY', catalog_item_id: null,
      catalog_item_name: null, analyzed_count: 20,
      partial_insights: [{ summary: 'Parcial.', recommendations: ['Ação.'] }],
    } as never, { provider: 'openrouter', apiKey: 'test-key', model: 'vendor/model' });
    expect(result.global_insights.summary).toBe('Resumo final.');
    expect(fetchMock.mock.calls[0][0]).toBe('http://ia-analyze.test/internal/ia-analyze/synthesize-insights');
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      'x-llm-provider': 'openrouter', 'x-llm-api-key': 'test-key', 'x-llm-model': 'vendor/model',
    });
  });
});
