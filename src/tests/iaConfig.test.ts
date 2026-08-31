import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../index.js';
import { resolveEnterpriseIdByUser } from '../repositories/enterprise.repository.js';
import {
  getIaConfigByEnterprise,
  upsertIaConfig,
  deleteIaConfig,
} from '../repositories/iaConfig.repository.js';
import { encryptSecret } from '../utils/crypto.js';
import { validateOpenRouterKey } from '../libs/iaConfig/validateOpenRouterKey.js';

const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';
const ENT = 'ent-1';

const { authState } = vi.hoisted(() => ({ authState: { user: null as { id: string } | null } }));
vi.mock('../middlewares/auth.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requireAuth: (req: any, res: any, next: any) => {
    if (!authState.user) return res.status(401).json({ error: 'unauthorized' });
    req.user = authState.user;
    next();
  },
}));
vi.mock('../repositories/enterprise.repository.js', () => ({ resolveEnterpriseIdByUser: vi.fn() }));
vi.mock('../repositories/iaConfig.repository.js', () => ({
  getIaConfigByEnterprise: vi.fn(),
  upsertIaConfig: vi.fn(),
  deleteIaConfig: vi.fn(),
}));
vi.mock('../utils/crypto.js', () => ({
  encryptSecret: vi.fn(() => ({ ciphertext: 'c', iv: 'i', authTag: 't' })),
}));
vi.mock('../libs/iaConfig/validateOpenRouterKey.js', () => ({ validateOpenRouterKey: vi.fn() }));

const mGet = vi.mocked(getIaConfigByEnterprise);
const mUpsert = vi.mocked(upsertIaConfig);
const mDelete = vi.mocked(deleteIaConfig);
const mEncrypt = vi.mocked(encryptSecret);
const mValidate = vi.mocked(validateOpenRouterKey);
const mResolveEnt = vi.mocked(resolveEnterpriseIdByUser);

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = { id: TEST_USER_ID };
  mResolveEnt.mockResolvedValue(ENT);
  mEncrypt.mockReturnValue({ ciphertext: 'c', iv: 'i', authTag: 't' });
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
    mValidate.mockResolvedValueOnce(true);
    const res = await request(app)
      .put('/api/protected/user/ia-config')
      .send({ provider: 'openrouter', model: 'openrouter/auto', apiKey: 'sk-or-abcd1234' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasKey: true, provider: 'openrouter', model: 'openrouter/auto', keyHint: '1234' });
    expect(mEncrypt).toHaveBeenCalledWith('sk-or-abcd1234');
    expect(mUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ enterpriseId: ENT, provider: 'openrouter', keyHint: '1234', apiKeyCiphertext: 'c' }),
    );
  });

  it('chave OpenRouter inválida → 400 ia_config_invalid_key (não faz upsert)', async () => {
    mValidate.mockResolvedValueOnce(false);
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
    expect(mValidate).not.toHaveBeenCalled();
    expect(mUpsert).not.toHaveBeenCalled();
  });
});

describe('[Integração] DELETE /api/protected/user/ia-config', () => {
  it('remove a config → hasKey false', async () => {
    const res = await request(app).delete('/api/protected/user/ia-config');
    expect(res.status).toBe(200);
    expect(res.body.hasKey).toBe(false);
    expect(mDelete).toHaveBeenCalledWith(ENT);
  });
});
