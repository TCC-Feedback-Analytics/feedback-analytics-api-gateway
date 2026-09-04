import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenRouterModelsCatalog } from '../libs/iaConfig/openRouterModels.js';

const START = Date.parse('2026-09-04T12:00:00Z');
const minute = 60_000;
const publicSource = { kind: 'public' } as const;
const userSource = { kind: 'user', enterpriseId: 'ent-A', apiKey: 'secret-A' } as const;

function model(id = 'vendor/model', overrides: Record<string, unknown> = {}) {
  return {
    id, name: id,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    supported_parameters: ['response_format'], context_length: 128_000,
    top_provider: { max_completion_tokens: 32_768 }, expiration_date: null,
    ...overrides,
  };
}

function response(data: unknown[] = [model()]) {
  return Response.json({ data });
}

function setup() {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response());
  let now = START;
  const catalog = createOpenRouterModelsCatalog({ fetch, now: () => now });
  return { fetch, catalog, advance: (ms: number) => { now += ms; } };
}

afterEach(() => { vi.useRealTimers(); });

describe('OpenRouter — catálogo e compatibilidade do executor', () => {
  it('consulta catálogo público sem token, sem paginação e bloqueia redirects', async () => {
    const { catalog, fetch } = setup();
    const result = await catalog.get(publicSource);
    expect(fetch).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models?output_modalities=text', {
      headers: {}, signal: expect.any(AbortSignal), redirect: 'error',
    });
    expect(result).toEqual({
      source: 'public', fetchedAt: new Date(START).toISOString(), stale: false,
      models: [{ id: 'vendor/model', name: 'vendor/model', contextLength: 128_000, maxCompletionTokens: 32_768, isAutomatic: false }],
    });
  });

  it('consulta catálogo da conta com Bearer e nunca expõe campos extras do upstream', async () => {
    const { catalog, fetch } = setup();
    fetch.mockResolvedValueOnce(response([model('vendor/model', { secret: 'should-not-escape', pricing: { prompt: '1' } })]));
    const result = await catalog.get(userSource);
    expect(fetch).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models/user?output_modalities=text', {
      headers: { Authorization: 'Bearer secret-A' }, signal: expect.any(AbortSignal), redirect: 'error',
    });
    expect(result.source).toBe('user');
    expect(JSON.stringify(result)).not.toMatch(/secret|pricing|Authorization/);
  });

  it('filtra texto/JSON, saída 16K, contexto, expiração e limites desconhecidos', async () => {
    const { catalog, fetch } = setup();
    fetch.mockResolvedValueOnce(response([
      model('vendor/compatible', { top_provider: { max_completion_tokens: 16_384 } }),
      model('vendor/no-json', { supported_parameters: ['temperature'] }),
      model('vendor/no-text-in', { architecture: { input_modalities: ['image'], output_modalities: ['text'] } }),
      model('vendor/no-text-out', { architecture: { input_modalities: ['text'], output_modalities: ['image'] } }),
      model('vendor/output-small', { top_provider: { max_completion_tokens: 16_383 } }),
      model('vendor/context-small', { context_length: 16_384 }),
      model('vendor/context-unknown', { context_length: null }),
      model('vendor/output-unknown', { top_provider: null }),
      model('vendor/expired', { expiration_date: '2026-09-03' }),
      model('vendor/invalid-expiration', { expiration_date: 'not-a-date' }),
      model('vendor/future', { expiration_date: '2027-01-01' }),
      model('vendor/malformed', { architecture: null }),
      { id: 'incomplete' },
    ]));
    expect((await catalog.get(publicSource)).models.map((entry) => entry.id))
      .toEqual(['vendor/compatible', 'vendor/future']);
  });

  it('mantém auto somente se existir no catálogo com suporte a texto/JSON; deduplica e ordena', async () => {
    const { catalog, fetch } = setup();
    fetch.mockResolvedValueOnce(response([
      model('vendor/z', { name: 'Z' }), model('vendor/a', { name: 'A' }), model('vendor/a', { name: 'A' }),
      model('openrouter/auto', { name: 'Roteamento automático', context_length: null, top_provider: null }),
    ]));
    const result = await catalog.get(publicSource);
    expect(result.models.map((entry) => entry.id)).toEqual(['openrouter/auto', 'vendor/a', 'vendor/z']);
    expect(result.models[0].isAutomatic).toBe(true);
    fetch.mockResolvedValueOnce(response([model('openrouter/auto', { supported_parameters: [] })]));
    expect((await catalog.get(publicSource, { forceRefresh: true })).models).toEqual([]);
    fetch.mockResolvedValueOnce(response([]));
    expect((await catalog.get(publicSource, { forceRefresh: true })).models).toEqual([]);
  });

  it.each([{ data: [null, {}] }, { models: [] }, null, { data: 'wrong' }])('payload malformado vira erro tipado: %j', async (body) => {
    const { catalog, fetch } = setup();
    fetch.mockResolvedValueOnce(Response.json(body));
    await expect(catalog.get(publicSource)).rejects.toMatchObject({ status: 503, code: 'ia_models_unavailable', transient: true });
  });
});

describe('OpenRouter — cache limitado e isolamento', () => {
  it('TTL de cinco minutos; forceRefresh ignora entrada recente', async () => {
    const { catalog, fetch, advance } = setup();
    await catalog.get(publicSource);
    advance(5 * minute - 1);
    await catalog.get(publicSource);
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(1);
    await catalog.get(publicSource);
    expect(fetch).toHaveBeenCalledTimes(2);
    await catalog.get(publicSource, { forceRefresh: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('separa público, empresas e chaves e invalida só a empresa solicitada', async () => {
    const { catalog, fetch } = setup();
    const otherKey = { ...userSource, apiKey: 'secret-B' };
    const otherEnterprise = { ...userSource, enterpriseId: 'ent-B' };
    for (const source of [publicSource, userSource, otherKey, otherEnterprise]) await catalog.get(source);
    expect(fetch).toHaveBeenCalledTimes(4);
    catalog.invalidateEnterprise('ent-A');
    await catalog.get(publicSource);
    await catalog.get(otherEnterprise);
    expect(fetch).toHaveBeenCalledTimes(4);
    await catalog.get(userSource);
    await catalog.get(otherKey);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it('deduplica refreshes simultâneos, inclusive validação de gravação', async () => {
    const { catalog, fetch } = setup();
    let resolve!: (value: Response) => void;
    fetch.mockReturnValueOnce(new Promise<Response>((done) => { resolve = done; }));
    const first = catalog.get(userSource);
    const second = catalog.get(userSource, { forceRefresh: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    resolve(response());
    expect(await first).toEqual(await second);
  });

  it('invalidação durante fetch impede que a resposta ressuscite o cache', async () => {
    const { catalog, fetch } = setup();
    let resolve!: (value: Response) => void;
    fetch.mockReturnValueOnce(new Promise<Response>((done) => { resolve = done; }));
    const pending = catalog.get(userSource);
    catalog.invalidateEnterprise(userSource.enterpriseId);
    resolve(response());
    await pending;
    await catalog.get(userSource);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('limita o cache a 100 entradas', async () => {
    const { catalog, fetch } = setup();
    for (let i = 0; i < 101; i += 1) await catalog.get({ ...userSource, enterpriseId: `ent-${i}` });
    await catalog.get({ ...userSource, enterpriseId: 'ent-100' });
    expect(fetch).toHaveBeenCalledTimes(101);
    await catalog.get({ ...userSource, enterpriseId: 'ent-0' });
    expect(fetch).toHaveBeenCalledTimes(102);
  });

  it('rejeita tenant vazio ou chave vazia sem consulta externa', async () => {
    const { catalog, fetch } = setup();
    await expect(catalog.get({ ...userSource, enterpriseId: '' })).rejects.toThrow();
    await expect(catalog.get({ ...userSource, apiKey: ' ' })).rejects.toMatchObject({ code: 'ia_config_invalid_key' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('OpenRouter — falhas e stale somente para leitura', () => {
  it.each([429, 500, 502, 503])('HTTP %s permite stale em leitura mas nunca em gravação', async (status) => {
    const { catalog, fetch, advance } = setup();
    const original = await catalog.get(userSource);
    advance(6 * minute);
    fetch.mockImplementation(async () => new Response('sensitive-upstream-body', { status }));
    expect(await catalog.get(userSource, { allowStale: true })).toEqual({ ...original, stale: true });
    await expect(catalog.get(userSource, { forceRefresh: true })).rejects.toMatchObject({ status: 503, code: 'ia_models_unavailable' });
    advance(24 * minute);
    await expect(catalog.get(userSource, { allowStale: true })).rejects.toMatchObject({ status: 503 });
  });

  it.each([[401, 400, 'ia_config_invalid_key'], [403, 403, 'ia_models_forbidden']])(
    'HTTP %s não usa stale/fallback público e elimina o cache', async (upstream, status, code) => {
      const { catalog, fetch } = setup();
      await catalog.get(userSource);
      fetch.mockImplementation(async () => new Response('sensitive-key', { status: upstream as number }));
      await expect(catalog.get(userSource, { allowStale: true, forceRefresh: true }))
        .rejects.toMatchObject({ status, code, transient: false });
      // Mesmo dentro do TTL, a entrada reprovada precisa ser consultada de novo.
      await expect(catalog.get(userSource, { allowStale: true })).rejects.toMatchObject({ code });
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(fetch.mock.calls.every(([url]) => String(url).includes('/models/user?'))).toBe(true);
    },
  );

  it('sem cache, falha de rede retorna erro sanitizado', async () => {
    const { catalog, fetch } = setup();
    fetch.mockRejectedValueOnce(new Error('secret-A Authorization upstream details'));
    const error = await catalog.get(userSource, { allowStale: true }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 503, code: 'ia_models_unavailable', message: 'ia_models_unavailable' });
    expect(JSON.stringify(error)).not.toMatch(/secret-A|Authorization/);
  });

  it('JSON inválido pode usar stale na leitura', async () => {
    const { catalog, fetch, advance } = setup();
    await catalog.get(publicSource);
    advance(6 * minute);
    fetch.mockResolvedValueOnce(new Response('invalid-json', { status: 200 }));
    expect((await catalog.get(publicSource, { allowStale: true })).stale).toBe(true);
  });

  it('aborta consulta após oito segundos e limpa o timer', async () => {
    vi.useFakeTimers();
    const { catalog, fetch } = setup();
    let signal: AbortSignal | undefined;
    fetch.mockImplementationOnce((_url, init) => new Promise<Response>((_resolve, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener('abort', () => reject(new Error('AbortError')), { once: true });
    }));
    const pending = expect(catalog.get(userSource)).rejects.toMatchObject({ status: 503, code: 'ia_models_unavailable' });
    await vi.advanceTimersByTimeAsync(8_000);
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
