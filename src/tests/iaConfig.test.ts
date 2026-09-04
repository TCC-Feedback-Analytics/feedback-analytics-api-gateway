import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { RequestHandler } from 'express';
import app from '../../index.js';
import { resolveEnterpriseIdByUser } from '../repositories/enterprise.repository.js';
import {
  getIaConfigByEnterprise,
  upsertIaConfig,
  deleteIaConfig,
  updateIaModel,
  type IaConfigRow,
} from '../repositories/iaConfig.repository.js';
import { decryptSecret, encryptSecret } from '../utils/crypto.js';
import { openRouterModels, type IaModelsCatalog } from '../libs/iaConfig/openRouterModels.js';
import { IaConfigError } from '../libs/iaConfig/iaConfigError.js';

const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';
const ENT = 'ent-1';

const { authState } = vi.hoisted(() => ({ authState: {
  user: null as { id: string } | null,
  enterpriseId: undefined as string | undefined,
} }));
vi.mock('../middlewares/auth.js', () => ({
  requireAuth: ((req, res, next) => {
    if (!authState.user) return res.status(401).json({ error: 'unauthorized' });
    req.user = authState.user;
    req.enterpriseId = authState.enterpriseId;
    next();
  }) satisfies RequestHandler,
}));
vi.mock('../repositories/enterprise.repository.js', () => ({ resolveEnterpriseIdByUser: vi.fn() }));
vi.mock('../repositories/iaConfig.repository.js', () => ({
  getIaConfigByEnterprise: vi.fn(),
  upsertIaConfig: vi.fn(),
  deleteIaConfig: vi.fn(),
  updateIaModel: vi.fn(),
}));
vi.mock('../utils/crypto.js', () => ({
  encryptSecret: vi.fn(() => ({ ciphertext: 'c', iv: 'i', authTag: 't' })),
  decryptSecret: vi.fn(),
}));
vi.mock('../libs/iaConfig/openRouterModels.js', () => ({
  DEFAULT_IA_MODEL: 'openrouter/auto',
  openRouterModels: { get: vi.fn(), invalidateEnterprise: vi.fn() },
}));

const mGet = vi.mocked(getIaConfigByEnterprise);
const mUpsert = vi.mocked(upsertIaConfig);
const mDelete = vi.mocked(deleteIaConfig);
const mEncrypt = vi.mocked(encryptSecret);
const mDecrypt = vi.mocked(decryptSecret);
const mCatalog = vi.mocked(openRouterModels.get);
const mInvalidate = vi.mocked(openRouterModels.invalidateEnterprise);
const mUpdate = vi.mocked(updateIaModel);
const mResolveEnt = vi.mocked(resolveEnterpriseIdByUser);
const storedConfig: IaConfigRow = {
  id: 'config-1', enterpriseId: ENT, provider: 'openrouter', model: 'openrouter/auto',
  apiKeyCiphertext: 'c', apiKeyIv: 'i', apiKeyAuthTag: 't', keyHint: 'xyz9',
};
const catalog: IaModelsCatalog = {
  models: [
    { id: 'openrouter/auto', name: 'Automático', contextLength: null, maxCompletionTokens: null, isAutomatic: true },
    { id: 'vendor/model', name: 'Modelo', contextLength: 128_000, maxCompletionTokens: 32_768, isAutomatic: false },
  ],
  source: 'user', fetchedAt: '2026-09-04T12:00:00.000Z', stale: false,
};

beforeEach(() => {
  vi.resetAllMocks();
  authState.user = { id: TEST_USER_ID };
  authState.enterpriseId = undefined;
  mResolveEnt.mockResolvedValue(ENT);
  mEncrypt.mockReturnValue({ ciphertext: 'c', iv: 'i', authTag: 't' });
  mDecrypt.mockReturnValue('sk-or-stored-secret');
  mGet.mockResolvedValue({ ...storedConfig });
  mCatalog.mockResolvedValue(catalog);
  mUpdate.mockResolvedValue({ hasKey: true, provider: 'openrouter', model: 'vendor/model', keyHint: 'xyz9' });
});

describe('[Integração] GET /api/protected/user/ia-config', () => {
  it('sem config → hasKey false', async () => {
    mGet.mockResolvedValueOnce(null);
    const res = await request(app).get('/api/protected/user/ia-config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasKey: false, provider: null, model: null, keyHint: null });
  });

  it('com config → hasKey true + provider/model/keyHint, NUNCA a chave', async () => {
    mGet.mockResolvedValueOnce({
      id: 'config-1',
      enterpriseId: ENT,
      provider: 'openrouter',
      model: 'anthropic/claude-3.5-sonnet',
      apiKeyCiphertext: 'c',
      apiKeyIv: 'i',
      apiKeyAuthTag: 't',
      keyHint: 'xyz9',
    });
    const res = await request(app).get('/api/protected/user/ia-config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasKey: true, provider: 'openrouter', model: 'anthropic/claude-3.5-sonnet', keyHint: 'xyz9' });
    expect(JSON.stringify(res.body)).not.toContain('ciphertext');
  });

  it('401 sem autenticação', async () => {
    authState.user = null;
    const res = await request(app).get('/api/protected/user/ia-config');
    expect(res.status).toBe(401);
  });
});

describe('[Integração] PUT /api/protected/user/ia-config', () => {
  it('chave OpenRouter válida → cifra, faz upsert e responde hasKey true', async () => {
    const res = await request(app)
      .put('/api/protected/user/ia-config')
      .send({ provider: 'openrouter', model: 'openrouter/auto', apiKey: 'sk-or-abcd1234' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasKey: true, provider: 'openrouter', model: 'openrouter/auto', keyHint: '1234' });
    expect(mEncrypt).toHaveBeenCalledWith('sk-or-abcd1234');
    expect(mCatalog).toHaveBeenCalledWith(
      { kind: 'user', enterpriseId: ENT, apiKey: 'sk-or-abcd1234' }, { forceRefresh: true },
    );
    expect(mInvalidate).toHaveBeenCalledWith(ENT);
    expect(mUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ enterpriseId: ENT, provider: 'openrouter', keyHint: '1234', apiKeyCiphertext: 'c' }),
    );
  });

  it('chave OpenRouter inválida → 400 ia_config_invalid_key (não faz upsert)', async () => {
    mCatalog.mockRejectedValueOnce(new IaConfigError(400, 'ia_config_invalid_key'));
    const res = await request(app)
      .put('/api/protected/user/ia-config')
      .send({ provider: 'openrouter', apiKey: 'sk-or-invalid' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ia_config_invalid_key');
    expect(mUpsert).not.toHaveBeenCalled();
  });

  it('payload inválido (sem apiKey) → 400 invalid_payload', async () => {
    const res = await request(app).put('/api/protected/user/ia-config').send({ provider: 'openrouter' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_payload');
  });

  it('rejeita provider diferente de OpenRouter', async () => {
    const res = await request(app)
      .put('/api/protected/user/ia-config')
      .send({ provider: 'gemini', apiKey: 'gemini-key-abcd' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_payload');
    expect(mCatalog).not.toHaveBeenCalled();
    expect(mUpsert).not.toHaveBeenCalled();
  });
});

describe('[Integração] DELETE /api/protected/user/ia-config', () => {
  it('remove a config → hasKey false', async () => {
    const res = await request(app).delete('/api/protected/user/ia-config');
    expect(res.status).toBe(200);
    expect(res.body.hasKey).toBe(false);
    expect(mDelete).toHaveBeenCalledWith(ENT);
    expect(mInvalidate).toHaveBeenCalledWith(ENT);
  });
});

describe('[Integração] GET /api/protected/user/ia-models', () => {
  it('sem chave consulta catálogo público sem decifrar credenciais', async () => {
    mGet.mockResolvedValueOnce(null);
    mCatalog.mockResolvedValueOnce({ ...catalog, source: 'public' });
    const res = await request(app).get('/api/protected/user/ia-models');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(mCatalog).toHaveBeenCalledWith({ kind: 'public' }, { allowStale: true });
    expect(mDecrypt).not.toHaveBeenCalled();
    expect(res.body).toEqual({ ...catalog, source: 'public', currentModel: null, currentModelAvailable: null });
  });

  it('usa somente a empresa autenticada e não devolve chave/cifra', async () => {
    authState.enterpriseId = ENT;
    const res = await request(app).get('/api/protected/user/ia-models?enterpriseId=other');
    expect(res.status).toBe(200);
    expect(mResolveEnt).not.toHaveBeenCalled();
    expect(mGet).toHaveBeenCalledWith(ENT);
    expect(mDecrypt).toHaveBeenCalledWith({ ciphertext: 'c', iv: 'i', authTag: 't' });
    expect(mCatalog).toHaveBeenCalledWith(
      { kind: 'user', enterpriseId: ENT, apiKey: 'sk-or-stored-secret' }, { allowStale: true },
    );
    expect(res.body).toEqual({ ...catalog, currentModel: 'openrouter/auto', currentModelAvailable: true });
    expect(JSON.stringify(res.body)).not.toMatch(/sk-or|apiKey|ciphertext|authTag/);
  });

  it('preserva modelo atual ausente no catálogo e informa indisponibilidade', async () => {
    mGet.mockResolvedValueOnce({ ...storedConfig, model: 'vendor/retired' });
    const res = await request(app).get('/api/protected/user/ia-models');
    expect(res.body.currentModel).toBe('vendor/retired');
    expect(res.body.currentModelAvailable).toBe(false);
    expect(res.body.models).toEqual(catalog.models);
    expect(mUpdate).not.toHaveBeenCalled();
    expect(mUpsert).not.toHaveBeenCalled();
  });

  it('config antiga com modelo null resolve o padrão sem gravá-lo', async () => {
    mGet.mockResolvedValueOnce({ ...storedConfig, model: null });
    const res = await request(app).get('/api/protected/user/ia-models');
    expect(res.body.currentModel).toBe('openrouter/auto');
    expect(mUpsert).not.toHaveBeenCalled();
  });

  it('expõe stale para a UI poder avisar sobre catálogo antigo', async () => {
    mCatalog.mockResolvedValueOnce({ ...catalog, stale: true });
    const res = await request(app).get('/api/protected/user/ia-models');
    expect(res.status).toBe(200);
    expect(res.body.stale).toBe(true);
  });

  it.each([
    [400, 'ia_config_invalid_key'], [403, 'ia_models_forbidden'], [503, 'ia_models_unavailable'],
  ])('propaga erro %s sem fallback para o catálogo público', async (status, code) => {
    mCatalog.mockRejectedValueOnce(new IaConfigError(status as number, code as string));
    const res = await request(app).get('/api/protected/user/ia-models');
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(code);
    expect(mCatalog).toHaveBeenCalledTimes(1);
  });
});

describe('[Integração] PATCH /api/protected/user/ia-config/model', () => {
  it('altera só o modelo, validando com a chave armazenada e guardando snapshot para UPDATE', async () => {
    const res = await request(app).patch('/api/protected/user/ia-config/model').send({ model: ' vendor/model ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasKey: true, provider: 'openrouter', model: 'vendor/model', keyHint: 'xyz9' });
    expect(mCatalog).toHaveBeenCalledWith(
      { kind: 'user', enterpriseId: ENT, apiKey: 'sk-or-stored-secret' }, { forceRefresh: true },
    );
    expect(mUpdate).toHaveBeenCalledWith(ENT, storedConfig, 'vendor/model');
    expect(mEncrypt).not.toHaveBeenCalled();
    expect(mUpsert).not.toHaveBeenCalled();
    expect(mDelete).not.toHaveBeenCalled();
  });

  it.each([{}, { model: '' }, { model: '   ' }, { model: null }, { model: 'x'.repeat(121) },
    { model: 'vendor/model', apiKey: 'sk-or-new-key' }, { model: 'vendor/model', enterpriseId: 'other' },
  ])('rejeita payload inválido ou campos extras: %j', async (body) => {
    const res = await request(app).patch('/api/protected/user/ia-config/model').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_payload');
    expect(mCatalog).not.toHaveBeenCalled();
    expect(mUpdate).not.toHaveBeenCalled();
  });

  it('sem chave não tenta consultar OpenRouter nem recriar configuração', async () => {
    mGet.mockResolvedValueOnce(null);
    const res = await request(app).patch('/api/protected/user/ia-config/model').send({ model: 'vendor/model' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ia_config_required');
    expect(mCatalog).not.toHaveBeenCalled();
    expect(mUpdate).not.toHaveBeenCalled();
    expect(mUpsert).not.toHaveBeenCalled();
  });

  it('remoção ou troca concorrente retorna conflito, sem upsert', async () => {
    mUpdate.mockResolvedValueOnce(null);
    const res = await request(app).patch('/api/protected/user/ia-config/model').send({ model: 'vendor/model' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ia_config_changed');
    expect(mUpsert).not.toHaveBeenCalled();
  });
});

describe('[Integração] Validação compartilhada de modelo e segurança', () => {
  const mutations = [
    { method: 'put', path: '/api/protected/user/ia-config', body: { apiKey: 'sk-or-new', model: 'vendor/model' } },
    { method: 'patch', path: '/api/protected/user/ia-config/model', body: { model: 'vendor/model' } },
  ] as const;

  for (const { method, path, body } of mutations) {
    it(`${method}: modelo fora do catálogo não cifra nem escreve`, async () => {
      mCatalog.mockResolvedValueOnce({ ...catalog, models: [] });
      const res = await request(app)[method](path).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('ia_model_unavailable');
      expect(mEncrypt).not.toHaveBeenCalled();
      expect(mUpdate).not.toHaveBeenCalled();
      expect(mUpsert).not.toHaveBeenCalled();
    });

    it(`${method}: catálogo stale nunca autoriza uma gravação`, async () => {
      mCatalog.mockResolvedValueOnce({ ...catalog, stale: true });
      const res = await request(app)[method](path).send(body);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('ia_models_unavailable');
      expect(mUpdate).not.toHaveBeenCalled();
      expect(mUpsert).not.toHaveBeenCalled();
    });

    it(`${method}: falha transitória não grava nem invalida configuração`, async () => {
      mCatalog.mockRejectedValueOnce(new IaConfigError(503, 'ia_models_unavailable', true));
      const res = await request(app)[method](path).send(body);
      expect(res.status).toBe(503);
      expect(mUpdate).not.toHaveBeenCalled();
      expect(mUpsert).not.toHaveBeenCalled();
      expect(mInvalidate).not.toHaveBeenCalled();
    });
  }

  it.each([undefined, '   '])('PUT sem modelo explícito valida e persiste openrouter/auto (%s)', async (model) => {
    const res = await request(app).put('/api/protected/user/ia-config').send({ apiKey: 'sk-or-new', model });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe('openrouter/auto');
    expect(mUpsert).toHaveBeenCalledWith(expect.objectContaining({ model: 'openrouter/auto' }));
  });

  const endpoints = [
    { method: 'get', path: '/api/protected/user/ia-config' },
    { method: 'get', path: '/api/protected/user/ia-models' },
    { method: 'put', path: '/api/protected/user/ia-config' },
    { method: 'patch', path: '/api/protected/user/ia-config/model' },
    { method: 'delete', path: '/api/protected/user/ia-config' },
  ] as const;
  for (const { method, path } of endpoints) {
    it(`${method} ${path}: exige sessão`, async () => {
      authState.user = null;
      const res = await request(app)[method](path).send({ apiKey: 'test', model: 'vendor/model' });
      expect(res.status).toBe(401);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(mGet).not.toHaveBeenCalled();
      expect(mCatalog).not.toHaveBeenCalled();
    });

    it(`${method} ${path}: exige empresa resolvida no servidor`, async () => {
      mResolveEnt.mockResolvedValueOnce(null);
      const body = method === 'patch' ? { model: 'vendor/model' } : { apiKey: 'test', model: 'vendor/model' };
      const res = await request(app)[method](path).send(body);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('enterprise_not_found');
      expect(mCatalog).not.toHaveBeenCalled();
      expect(mUpdate).not.toHaveBeenCalled();
    });
  }

  it('erro na decifra é sanitizado no log e na resposta, sem fallback público', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mDecrypt.mockImplementationOnce(() => { throw new Error('sensitive-decryption-material'); });
      const res = await request(app).get('/api/protected/user/ia-models');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('internal_server_error');
      expect(JSON.stringify(res.body)).not.toContain('sensitive');
      expect(JSON.stringify(log.mock.calls)).not.toContain('sensitive');
      expect(mCatalog).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('falha ao salvar não invalida cache e não expõe parâmetros do banco', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mUpsert.mockRejectedValueOnce(new Error('sensitive-db-parameters'));
      const res = await request(app).put('/api/protected/user/ia-config').send({ apiKey: 'sk-or-new' });
      expect(res.status).toBe(500);
      expect(mInvalidate).not.toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).not.toContain('sensitive');
    } finally {
      log.mockRestore();
    }
  });
});
