import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  API_ERROR_IA_CONFIG_INVALID_KEY,
  API_ERROR_IA_MODELS_FORBIDDEN,
  API_ERROR_IA_MODELS_UNAVAILABLE,
} from '../../config/errors.js';
import { assertEnterpriseId } from '../../db/tenantScope.js';
import { IaConfigError } from './iaConfigError.js';

export const DEFAULT_IA_MODEL = 'openrouter/auto';
// Deve acompanhar MAX_OUTPUT_TOKENS no executor ia-analyze. Não inferir que
// todo modelo do catálogo suporta o contrato JSON + 16K de saída atual.
export const REQUIRED_OUTPUT_TOKENS = 16_384;
const CACHE_TTL_MS = 5 * 60_000;
const MAX_STALE_AGE_MS = 30 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_CACHE_ENTRIES = 100;

export interface IaModelOption {
  id: string;
  name: string;
  contextLength: number | null;
  maxCompletionTokens: number | null;
  isAutomatic: boolean;
}

export interface IaModelsCatalog {
  models: IaModelOption[];
  source: 'public' | 'user';
  fetchedAt: string;
  stale: boolean;
}

type CatalogSource = { kind: 'public' } | {
  kind: 'user';
  enterpriseId: string;
  apiKey: string;
};

const upstreamModelSchema = z.object({
  id: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(300),
  architecture: z.object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
  }),
  supported_parameters: z.array(z.string()),
  context_length: z.number().int().positive().nullish(),
  top_provider: z.object({
    max_completion_tokens: z.number().int().positive().nullish(),
  }).nullish(),
  expiration_date: z.string().nullish(),
});

function parseModels(payload: unknown, now: number): IaModelOption[] {
  const parsed = z.object({ data: z.array(z.unknown()) }).safeParse(payload);
  if (!parsed.success) throw new IaConfigError(503, API_ERROR_IA_MODELS_UNAVAILABLE, true);

  const models = new Map<string, IaModelOption>();
  let validRows = 0;
  for (const row of parsed.data.data) {
    const result = upstreamModelSchema.safeParse(row);
    if (!result.success) continue;
    validRows += 1;
    const model = result.data;
    const maxCompletionTokens = model.top_provider?.max_completion_tokens ?? null;
    const contextLength = model.context_length ?? null;
    const isAutomatic = model.id === DEFAULT_IA_MODEL;

    if (!model.architecture.input_modalities.includes('text') ||
        !model.architecture.output_modalities.includes('text') ||
        !model.supported_parameters.includes('response_format')) continue;

    if (model.expiration_date) {
      const expiration = Date.parse(model.expiration_date);
      if (!Number.isFinite(expiration) || expiration <= now) continue;
    }

    if (maxCompletionTokens !== null && maxCompletionTokens < REQUIRED_OUTPUT_TOKENS) continue;
    if (contextLength !== null && contextLength <= REQUIRED_OUTPUT_TOKENS) continue;
    // Auto é um roteador, não um modelo com teto fixo. Só o oferecemos se vier
    // do catálogo e declarar texto/JSON. Os limites finais dependem do destino.
    // Nos demais modelos, capacidade desconhecida não é compatibilidade.
    if (!isAutomatic && (maxCompletionTokens === null || contextLength === null)) continue;

    models.set(model.id, { id: model.id, name: model.name, contextLength, maxCompletionTokens, isAutomatic });
  }

  if (parsed.data.data.length > 0 && validRows === 0) {
    throw new IaConfigError(503, API_ERROR_IA_MODELS_UNAVAILABLE, true);
  }
  return [...models.values()].sort((a, b) =>
    Number(b.isAutomatic) - Number(a.isAutomatic) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

type CacheEntry = {
  enterpriseId: string | null;
  catalog?: IaModelsCatalog;
  fetchedAt?: number;
  pending?: Promise<IaModelsCatalog>;
};

/** Cache por instância Vercel, limitado e sem persistir tokens em suas chaves. */
export function createOpenRouterModelsCatalog(options: {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
} = {}) {
  const request = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  async function fetchCatalog(source: CatalogSource): Promise<IaModelsCatalog> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = source.kind === 'user'
        ? 'https://openrouter.ai/api/v1/models/user?output_modalities=text'
        : 'https://openrouter.ai/api/v1/models?output_modalities=text';
      // Sem paginação: ambos os parâmetros omitidos retornam o catálogo todo.
      // Host fixo e redirects bloqueados evitam encaminhar a chave a outro host.
      const response = await request(url, {
        headers: source.kind === 'user' ? { Authorization: `Bearer ${source.apiKey}` } : {},
        signal: controller.signal,
        redirect: 'error',
      });
      if (source.kind === 'user' && response.status === 401) {
        throw new IaConfigError(400, API_ERROR_IA_CONFIG_INVALID_KEY);
      }
      if (source.kind === 'user' && response.status === 403) {
        throw new IaConfigError(403, API_ERROR_IA_MODELS_FORBIDDEN);
      }
      if (!response.ok) {
        throw new IaConfigError(503, API_ERROR_IA_MODELS_UNAVAILABLE,
          response.status === 429 || response.status >= 500);
      }
      const payload: unknown = await response.json();
      const fetchedAt = now();
      return {
        models: parseModels(payload, fetchedAt),
        source: source.kind,
        fetchedAt: new Date(fetchedAt).toISOString(),
        stale: false,
      };
    } catch (error) {
      if (error instanceof IaConfigError) throw error;
      // Não guardar cause, mensagem, body ou headers que possam conter segredos.
      throw new IaConfigError(503, API_ERROR_IA_MODELS_UNAVAILABLE, true);
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async get(source: CatalogSource, readOptions: { allowStale?: boolean; forceRefresh?: boolean } = {}): Promise<IaModelsCatalog> {
      if (source.kind === 'user') {
        assertEnterpriseId(source.enterpriseId);
        if (!source.apiKey.trim()) throw new IaConfigError(400, API_ERROR_IA_CONFIG_INVALID_KEY);
      }
      const key = source.kind === 'public' ? 'public' : JSON.stringify([
        source.enterpriseId, createHash('sha256').update(source.apiKey).digest('hex'),
      ]);
      let entry = cache.get(key);
      if (!entry) {
        // Evita crescimento indefinido mesmo se muitas empresas/chaves consultarem.
        if (cache.size >= MAX_CACHE_ENTRIES) {
          const oldestKey = cache.keys().next().value;
          if (oldestKey !== undefined) cache.delete(oldestKey);
        }
        entry = { enterpriseId: source.kind === 'user' ? source.enterpriseId : null };
        cache.set(key, entry);
      }
      if (!readOptions.forceRefresh && entry.catalog &&
          now() - entry.fetchedAt! < CACHE_TTL_MS) return entry.catalog;

      const currentEntry = entry;
      if (!currentEntry.pending) {
        currentEntry.pending = fetchCatalog(source).then((catalog) => {
          // Uma invalidação/evicção durante o fetch não pode ressuscitar o cache.
          if (cache.get(key) === currentEntry) {
            currentEntry.catalog = catalog;
            currentEntry.fetchedAt = Date.parse(catalog.fetchedAt);
          }
          return catalog;
        }).finally(() => { currentEntry.pending = undefined; });
      }
      try {
        return await currentEntry.pending;
      } catch (error) {
        const transient = error instanceof IaConfigError && error.transient;
        if (!transient && cache.get(key) === currentEntry) cache.delete(key);
        if (readOptions.allowStale && transient && cache.get(key) === currentEntry &&
            currentEntry.catalog && now() - currentEntry.fetchedAt! < MAX_STALE_AGE_MS) {
          return { ...currentEntry.catalog, stale: true };
        }
        throw error;
      }
    },
    invalidateEnterprise(enterpriseId: string): void {
      for (const [key, entry] of cache) {
        if (entry.enterpriseId === enterpriseId) cache.delete(key);
      }
    },
  };
}

export const openRouterModels = createOpenRouterModelsCatalog();
