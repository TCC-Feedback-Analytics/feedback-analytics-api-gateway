import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import {
  getEnterpriseController,
  patchEnterpriseController,
  getCollectingDataController,
  patchCollectingDataController,
  upsertCollectingDataController,
} from '../controllers/protected/enterprise.controller.js';
import { resolveEnterpriseIdByUser } from '../repositories/enterprise.repository.js';
import {
  CollectingWriteError,
  getCatalogSnapshot,
  getCollectingDataByEnterprise,
  getCompanyQuestionsSnapshot,
  getEnterpriseByUser,
  saveCollectingDataPatch,
  saveCollectingDataUpsert,
  updateEnterpriseByUser,
} from '../repositories/collectingData.repository.js';

vi.mock('../repositories/enterprise.repository.js', () => ({
  resolveEnterpriseIdByUser: vi.fn(),
}));

// Mocka as funções do repo mantendo o CollectingWriteError real (importActual).
vi.mock('../repositories/collectingData.repository.js', async (importActual) => {
  const actual = await importActual<typeof import('../repositories/collectingData.repository.js')>();
  return {
    ...actual,
    getEnterpriseByUser: vi.fn(),
    updateEnterpriseByUser: vi.fn(),
    getCollectingDataByEnterprise: vi.fn(),
    getCatalogSnapshot: vi.fn(),
    getCompanyQuestionsSnapshot: vi.fn(),
    saveCollectingDataPatch: vi.fn(),
    saveCollectingDataUpsert: vi.fn(),
  };
});

const mockResolveEnterpriseIdByUser = vi.mocked(resolveEnterpriseIdByUser);
const mockGetEnterpriseByUser = vi.mocked(getEnterpriseByUser);
const mockUpdateEnterpriseByUser = vi.mocked(updateEnterpriseByUser);
const mockGetCollecting = vi.mocked(getCollectingDataByEnterprise);
const mockGetCatalogSnapshot = vi.mocked(getCatalogSnapshot);
const mockGetCompanyQuestions = vi.mocked(getCompanyQuestionsSnapshot);
const mockSavePatch = vi.mocked(saveCollectingDataPatch);
const mockSaveUpsert = vi.mocked(saveCollectingDataUpsert);

type MockRes = Response & { statusCode: number; body: unknown };

function mockRes(): MockRes {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload: unknown) => {
    res.body = payload;
    return res;
  };
  return res as MockRes;
}

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    user: { id: 'user-1', email: 'gestor@x.local', phone: null },
    body: {},
    ...overrides,
  } as unknown as Request;
}

const ENT_PROFILE = {
  id: 'ent-1',
  document: '12345678000199',
  account_type: 'CNPJ' as const,
  terms_version: 'v1',
  terms_accepted_at: null,
  created_at: null,
  trial_ends_at: null,
  subscription_status: 'TRIAL',
};

const COLLECTING_ROW = {
  id: 'col-1',
  enterprise_id: 'ent-1',
  company_objective: 'Objetivo',
  analytics_goal: null,
  business_summary: null,
  main_products_or_services: null,
  uses_company_products: false,
  uses_company_services: false,
  uses_company_departments: false,
  created_at: null,
  updated_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCatalogSnapshot.mockResolvedValue({ catalog_products: [], catalog_services: [], catalog_departments: [] });
  mockGetCompanyQuestions.mockResolvedValue([]);
});

describe('getEnterpriseController', () => {
  it('200 com { enterprise, user }', async () => {
    mockGetEnterpriseByUser.mockResolvedValueOnce(ENT_PROFILE);
    const res = mockRes();
    await getEnterpriseController(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      enterprise: ENT_PROFILE,
      user: { id: 'user-1', email: 'gestor@x.local', phone: null },
    });
  });

  it('404 quando a empresa não existe', async () => {
    mockGetEnterpriseByUser.mockResolvedValueOnce(null);
    const res = mockRes();
    await getEnterpriseController(mockReq(), res);
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: string }).error).toBe('enterprise_not_found');
  });
});

describe('patchEnterpriseController', () => {
  it('400 com payload inválido (nenhum campo)', async () => {
    const res = mockRes();
    await patchEnterpriseController(mockReq({ body: {} }), res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe('invalid_payload');
    expect(mockUpdateEnterpriseByUser).not.toHaveBeenCalled();
  });

  it('200 quando atualiza', async () => {
    mockUpdateEnterpriseByUser.mockResolvedValueOnce({ ...ENT_PROFILE, account_type: 'CPF' });
    const res = mockRes();
    await patchEnterpriseController(mockReq({ body: { account_type: 'CPF' } }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { enterprise: { account_type: string } }).enterprise.account_type).toBe('CPF');
  });

  it('401 quando o update não encontra a empresa', async () => {
    mockUpdateEnterpriseByUser.mockResolvedValueOnce(null);
    const res = mockRes();
    await patchEnterpriseController(mockReq({ body: { account_type: 'CPF' } }), res);
    expect(res.statusCode).toBe(401);
    expect((res.body as { error: string }).error).toBe('enterprise_not_found');
  });
});

describe('getCollectingDataController', () => {
  it('{ collecting: null } quando o usuário não tem empresa', async () => {
    mockResolveEnterpriseIdByUser.mockResolvedValueOnce(null);
    const res = mockRes();
    await getCollectingDataController(mockReq(), res);
    expect(res.body).toEqual({ collecting: null });
  });

  it('{ collecting: null } quando não há dados de coleta', async () => {
    mockGetCollecting.mockResolvedValueOnce(null);
    const res = mockRes();
    await getCollectingDataController(mockReq({ enterpriseId: 'ent-1' } as Partial<Request>), res);
    expect(res.body).toEqual({ collecting: null });
  });

  it('200 mesclando collecting + catálogo + perguntas', async () => {
    mockGetCollecting.mockResolvedValueOnce(COLLECTING_ROW);
    const res = mockRes();
    await getCollectingDataController(mockReq({ enterpriseId: 'ent-1' } as Partial<Request>), res);
    expect(res.statusCode).toBe(200);
    const body = res.body as { collecting: Record<string, unknown> };
    expect(body.collecting.company_objective).toBe('Objetivo');
    expect(body.collecting.catalog_products).toEqual([]);
    expect(body.collecting.company_feedback_questions).toEqual([]);
  });

  it('404 quando a leitura falha', async () => {
    mockGetCollecting.mockRejectedValueOnce(new Error('db down'));
    const res = mockRes();
    await getCollectingDataController(mockReq({ enterpriseId: 'ent-1' } as Partial<Request>), res);
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: string }).error).toBe('collecting_data_not_found');
  });
});

describe('patchCollectingDataController', () => {
  it('404 quando o usuário não tem empresa', async () => {
    mockResolveEnterpriseIdByUser.mockResolvedValueOnce(null);
    const res = mockRes();
    await patchCollectingDataController(mockReq({ body: { company_objective: 'x' } }), res);
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: string }).error).toBe('enterprise_not_found');
  });

  it('400 empty_payload quando nada relevante é enviado', async () => {
    const res = mockRes();
    await patchCollectingDataController(mockReq({ enterpriseId: 'ent-1', body: {} } as Partial<Request>), res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe('empty_payload');
    expect(mockSavePatch).not.toHaveBeenCalled();
  });

  it('400 upsert_failed quando as perguntas são inválidas', async () => {
    const res = mockRes();
    await patchCollectingDataController(
      mockReq({ enterpriseId: 'ent-1', body: { company_feedback_questions: [{ question_order: 1, question_text: 'curto', is_active: true, subquestions: [] }] } } as Partial<Request>),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe('upsert_failed');
    expect(mockSavePatch).not.toHaveBeenCalled();
  });

  it('200 e chama saveCollectingDataPatch', async () => {
    mockSavePatch.mockResolvedValueOnce(COLLECTING_ROW);
    const res = mockRes();
    await patchCollectingDataController(mockReq({ enterpriseId: 'ent-1', body: { company_objective: 'x' } } as Partial<Request>), res);
    expect(res.statusCode).toBe(200);
    expect(mockSavePatch).toHaveBeenCalledTimes(1);
    expect((res.body as { collecting: { company_objective: string } }).collecting.company_objective).toBe('Objetivo');
  });

  it('400 upsert_failed quando o writer lança CollectingWriteError', async () => {
    mockSavePatch.mockRejectedValueOnce(new CollectingWriteError());
    const res = mockRes();
    await patchCollectingDataController(mockReq({ enterpriseId: 'ent-1', body: { company_objective: 'x' } } as Partial<Request>), res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe('upsert_failed');
  });

  it('propaga erro de infra (não-CollectingWriteError) em vez de mascarar como 400', async () => {
    mockSavePatch.mockRejectedValueOnce(new Error('connection reset'));
    const res = mockRes();
    await expect(
      patchCollectingDataController(mockReq({ enterpriseId: 'ent-1', body: { company_objective: 'x' } } as Partial<Request>), res),
    ).rejects.toThrow('connection reset');
    expect(res.statusCode).not.toBe(400); // vira 500 via handler de erro do Express
  });
});

describe('upsertCollectingDataController', () => {
  it('404 quando o usuário não tem empresa', async () => {
    mockResolveEnterpriseIdByUser.mockResolvedValueOnce(null);
    const res = mockRes();
    await upsertCollectingDataController(mockReq({ body: {} }), res);
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: string }).error).toBe('enterprise_not_found');
  });

  it('200 e chama saveCollectingDataUpsert injetando as 3 perguntas default + os 3 catálogos', async () => {
    mockSaveUpsert.mockResolvedValueOnce(COLLECTING_ROW);
    const res = mockRes();
    await upsertCollectingDataController(mockReq({ enterpriseId: 'ent-1', body: {} } as Partial<Request>), res);
    expect(res.statusCode).toBe(200);
    expect(mockSaveUpsert).toHaveBeenCalledTimes(1);
    // Invariante nº3: upsert SEMPRE sincroniza as 3 perguntas COMPANY (defaults) e os 3 catálogos.
    const arg = mockSaveUpsert.mock.calls[0][0];
    expect(arg.plan.questions).toHaveLength(3);
    expect(arg.plan.questions?.map((q) => q.question_order)).toEqual([1, 2, 3]);
    expect(arg.plan.catalog.map((c) => c.kind)).toEqual(['PRODUCT', 'SERVICE', 'DEPARTMENT']);
    expect(arg.plan.catalog.every((c) => c.run)).toBe(true);
  });

  it('400 upsert_failed quando o writer lança CollectingWriteError', async () => {
    mockSaveUpsert.mockRejectedValueOnce(new CollectingWriteError());
    const res = mockRes();
    await upsertCollectingDataController(mockReq({ enterpriseId: 'ent-1', body: {} } as Partial<Request>), res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe('upsert_failed');
  });

  it('propaga erro de infra (não-CollectingWriteError) em vez de mascarar como 400', async () => {
    mockSaveUpsert.mockRejectedValueOnce(new Error('pool timeout'));
    const res = mockRes();
    await expect(
      upsertCollectingDataController(mockReq({ enterpriseId: 'ent-1', body: {} } as Partial<Request>), res),
    ).rejects.toThrow('pool timeout');
    expect(res.statusCode).not.toBe(400);
  });
});
