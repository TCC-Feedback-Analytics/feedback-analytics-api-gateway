import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import {
  getQrStatusController,
  enableQrController,
  disableQrController,
  getQrCatalogController,
  upsertCatalogQuestionsController,
  enableCatalogQrController,
  disableCatalogQrController,
} from '../controllers/protected/collectionPointsQr.controller.js';
import { resolveEnterpriseIdByUser } from '../repositories/enterprise.repository.js';
import {
  QrPointWriteError,
  activateOrCreateCatalogQr,
  activateOrCreateCompanyQr,
  deactivateCatalogQr,
  deactivateCompanyQr,
  findActiveCompanyQrPoint,
  findQrPointsForCatalogItems,
  getCatalogItemForEnterprise,
  getCatalogQuestionsSnapshot,
  listActiveCatalogItems,
  saveCatalogQuestions,
} from '../repositories/collectionPointsQr.repository.js';

vi.mock('../repositories/enterprise.repository.js', () => ({
  resolveEnterpriseIdByUser: vi.fn(),
}));

vi.mock('../repositories/collectionPointsQr.repository.js', async (importActual) => {
  const actual = await importActual<typeof import('../repositories/collectionPointsQr.repository.js')>();
  return {
    ...actual,
    getCatalogQuestionsSnapshot: vi.fn(),
    getCatalogItemForEnterprise: vi.fn(),
    listActiveCatalogItems: vi.fn(),
    findQrPointsForCatalogItems: vi.fn(),
    findActiveCompanyQrPoint: vi.fn(),
    activateOrCreateCompanyQr: vi.fn(),
    deactivateCompanyQr: vi.fn(),
    activateOrCreateCatalogQr: vi.fn(),
    deactivateCatalogQr: vi.fn(),
    saveCatalogQuestions: vi.fn(),
  };
});

const mockResolveByUser = vi.mocked(resolveEnterpriseIdByUser);
const mockFindActiveCompany = vi.mocked(findActiveCompanyQrPoint);
const mockActivateCompany = vi.mocked(activateOrCreateCompanyQr);
const mockDeactivateCompany = vi.mocked(deactivateCompanyQr);
const mockListItems = vi.mocked(listActiveCatalogItems);
const mockFindPoints = vi.mocked(findQrPointsForCatalogItems);
const mockSnapshot = vi.mocked(getCatalogQuestionsSnapshot);
const mockGetItem = vi.mocked(getCatalogItemForEnterprise);
const mockActivateCatalog = vi.mocked(activateOrCreateCatalogQr);
const mockDeactivateCatalog = vi.mocked(deactivateCatalogQr);
const mockSaveQuestions = vi.mocked(saveCatalogQuestions);

type MockRes = Response & { statusCode: number; body: unknown };
function mockRes(): MockRes {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  return res as MockRes;
}
function mockReq(overrides: Partial<Request> = {}): Request {
  return { user: { id: 'user-1' }, enterpriseId: 'ent-1', body: {}, query: {}, ...overrides } as unknown as Request;
}
function errorOf(res: MockRes): string {
  return (res.body as { error: string }).error;
}

const VALID_QUESTIONS = [
  { question_order: 1, question_text: 'x'.repeat(25), is_active: true, subquestions: [] },
  { question_order: 2, question_text: '', is_active: false, subquestions: [] },
  { question_order: 3, question_text: '', is_active: false, subquestions: [] },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getQrStatusController', () => {
  it('404 { active:false } sem empresa', async () => {
    mockResolveByUser.mockResolvedValueOnce(null);
    const res = mockRes();
    await getQrStatusController(mockReq({ enterpriseId: undefined } as Partial<Request>), res);
    expect(res.statusCode).toBe(404);
    expect((res.body as { active: boolean }).active).toBe(false);
  });

  it('200 { active, id }', async () => {
    mockFindActiveCompany.mockResolvedValueOnce({ id: 'cp-1' });
    const res = mockRes();
    await getQrStatusController(mockReq(), res);
    expect(res.body).toEqual({ active: true, id: 'cp-1' });
  });

  it('500 { active:false } quando a leitura falha', async () => {
    mockFindActiveCompany.mockRejectedValueOnce(new Error('db'));
    const res = mockRes();
    await getQrStatusController(mockReq(), res);
    expect(res.statusCode).toBe(500);
    expect((res.body as { active: boolean }).active).toBe(false);
  });
});

describe('enableQrController', () => {
  it('200 { id, active:true }', async () => {
    mockActivateCompany.mockResolvedValueOnce({ id: 'cp-1' });
    const res = mockRes();
    await enableQrController(mockReq(), res);
    expect(res.body).toEqual({ id: 'cp-1', active: true });
  });

  it('500 unable_to_activate_qr quando o write falha ao reativar', async () => {
    mockActivateCompany.mockRejectedValueOnce(new QrPointWriteError('activate'));
    const res = mockRes();
    await enableQrController(mockReq(), res);
    expect(res.statusCode).toBe(500);
    expect(errorOf(res)).toBe('unable_to_activate_qr');
  });

  it('500 unable_to_create_qr_cp quando o insert falha', async () => {
    mockActivateCompany.mockRejectedValueOnce(new QrPointWriteError('create'));
    const res = mockRes();
    await enableQrController(mockReq(), res);
    expect(res.statusCode).toBe(500);
    expect(errorOf(res)).toBe('unable_to_create_qr_cp');
  });

  it('propaga erro de infra (não vira 500 tipado)', async () => {
    mockActivateCompany.mockRejectedValueOnce(new Error('pool timeout'));
    const res = mockRes();
    await expect(enableQrController(mockReq(), res)).rejects.toThrow('pool timeout');
  });
});

describe('disableQrController', () => {
  it('200 { active:false }', async () => {
    mockDeactivateCompany.mockResolvedValueOnce(undefined);
    const res = mockRes();
    await disableQrController(mockReq(), res);
    expect(res.body).toEqual({ active: false });
  });

  it('500 unable_to_disable_qr quando falha', async () => {
    mockDeactivateCompany.mockRejectedValueOnce(new Error('db'));
    const res = mockRes();
    await disableQrController(mockReq(), res);
    expect(res.statusCode).toBe(500);
    expect(errorOf(res)).toBe('unable_to_disable_qr');
  });
});

describe('getQrCatalogController', () => {
  it('400 com kind inválido', async () => {
    const res = mockRes();
    await getQrCatalogController(mockReq({ query: { kind: 'FOO' } } as Partial<Request>), res);
    expect(res.statusCode).toBe(400);
  });

  it('{ items: [] } quando não há itens', async () => {
    mockListItems.mockResolvedValueOnce([]);
    const res = mockRes();
    await getQrCatalogController(mockReq({ query: { kind: 'PRODUCT' } } as Partial<Request>), res);
    expect(res.body).toEqual({ items: [] });
  });

  it('200 mapeando active + collection_point_id + questions', async () => {
    mockListItems.mockResolvedValueOnce([{ id: 'i1', name: 'Item', description: null, kind: 'PRODUCT' }]);
    mockFindPoints.mockResolvedValueOnce([{ id: 'p1', catalogItemId: 'i1', status: 'ACTIVE' }]);
    mockSnapshot.mockResolvedValueOnce(new Map([['i1', [{ id: 'q1', question_order: 1, question_text: 't', is_active: true, subquestions: [] }]]]));
    const res = mockRes();
    await getQrCatalogController(mockReq({ query: { kind: 'PRODUCT' } } as Partial<Request>), res);
    const body = res.body as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({ catalog_item_id: 'i1', active: true, collection_point_id: 'p1' });
    expect((body.items[0].questions as unknown[])).toHaveLength(1);
  });

  it('500 quando uma leitura falha', async () => {
    mockListItems.mockRejectedValueOnce(new Error('db'));
    const res = mockRes();
    await getQrCatalogController(mockReq({ query: { kind: 'PRODUCT' } } as Partial<Request>), res);
    expect(res.statusCode).toBe(500);
  });
});

describe('upsertCatalogQuestionsController', () => {
  it('400 quando falta catalog_item_id', async () => {
    const res = mockRes();
    await upsertCatalogQuestionsController(mockReq({ body: { questions: VALID_QUESTIONS } }), res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { reason: string }).reason).toBe('catalog_item_id_missing');
  });

  it('400 quando questions não tem 3 slots', async () => {
    const res = mockRes();
    await upsertCatalogQuestionsController(mockReq({ body: { catalog_item_id: 'i1', questions: [] } }), res);
    expect((res.body as { reason: string }).reason).toBe('questions_must_have_3_slots');
  });

  it('404 quando o item não existe/inativo', async () => {
    mockGetItem.mockResolvedValueOnce(null);
    const res = mockRes();
    await upsertCatalogQuestionsController(mockReq({ body: { catalog_item_id: 'i1', questions: VALID_QUESTIONS } }), res);
    expect(res.statusCode).toBe(404);
  });

  it('400 duplicate_question_order', async () => {
    mockGetItem.mockResolvedValueOnce({ id: 'i1', kind: 'PRODUCT', name: 'Item', status: 'ACTIVE' });
    const dup = [
      { question_order: 1, question_text: '', is_active: false, subquestions: [] },
      { question_order: 1, question_text: '', is_active: false, subquestions: [] },
      { question_order: 3, question_text: '', is_active: false, subquestions: [] },
    ];
    const res = mockRes();
    await upsertCatalogQuestionsController(mockReq({ body: { catalog_item_id: 'i1', questions: dup } }), res);
    expect((res.body as { reason: string }).reason).toBe('duplicate_question_order');
  });

  it('200 e chama saveCatalogQuestions', async () => {
    mockGetItem.mockResolvedValueOnce({ id: 'i1', kind: 'PRODUCT', name: 'Item', status: 'ACTIVE' });
    mockSaveQuestions.mockResolvedValueOnce(undefined);
    mockSnapshot.mockResolvedValueOnce(new Map([['i1', []]]));
    const res = mockRes();
    await upsertCatalogQuestionsController(mockReq({ body: { catalog_item_id: 'i1', questions: VALID_QUESTIONS } }), res);
    expect(res.statusCode).toBe(200);
    expect(mockSaveQuestions).toHaveBeenCalledTimes(1);
    expect((res.body as { catalog_item_id: string }).catalog_item_id).toBe('i1');
  });

  it('500 update_failed quando o writer falha', async () => {
    mockGetItem.mockResolvedValueOnce({ id: 'i1', kind: 'PRODUCT', name: 'Item', status: 'ACTIVE' });
    mockSaveQuestions.mockRejectedValueOnce(new Error('tx failed'));
    const res = mockRes();
    await upsertCatalogQuestionsController(mockReq({ body: { catalog_item_id: 'i1', questions: VALID_QUESTIONS } }), res);
    expect(res.statusCode).toBe(500);
    expect(errorOf(res)).toBe('update_failed');
  });
});

describe('enableCatalogQrController', () => {
  it('400 sem catalog_item_id', async () => {
    const res = mockRes();
    await enableCatalogQrController(mockReq({ body: {} }), res);
    expect(res.statusCode).toBe(400);
  });

  it('404 quando o item não existe/inativo', async () => {
    mockGetItem.mockResolvedValueOnce(null);
    const res = mockRes();
    await enableCatalogQrController(mockReq({ body: { catalog_item_id: 'i1' } }), res);
    expect(res.statusCode).toBe(404);
  });

  it('200 { catalog_item_id, collection_point_id, active }', async () => {
    mockGetItem.mockResolvedValueOnce({ id: 'i1', kind: 'PRODUCT', name: 'Item', status: 'ACTIVE' });
    mockActivateCatalog.mockResolvedValueOnce({ id: 'p1' });
    const res = mockRes();
    await enableCatalogQrController(mockReq({ body: { catalog_item_id: 'i1' } }), res);
    expect(res.body).toEqual({ catalog_item_id: 'i1', collection_point_id: 'p1', active: true });
  });

  it('500 unable_to_create_qr_cp quando o insert falha', async () => {
    mockGetItem.mockResolvedValueOnce({ id: 'i1', kind: 'PRODUCT', name: 'Item', status: 'ACTIVE' });
    mockActivateCatalog.mockRejectedValueOnce(new QrPointWriteError('create'));
    const res = mockRes();
    await enableCatalogQrController(mockReq({ body: { catalog_item_id: 'i1' } }), res);
    expect(res.statusCode).toBe(500);
    expect(errorOf(res)).toBe('unable_to_create_qr_cp');
  });
});

describe('disableCatalogQrController', () => {
  it('400 sem catalog_item_id', async () => {
    const res = mockRes();
    await disableCatalogQrController(mockReq({ body: {} }), res);
    expect(res.statusCode).toBe(400);
  });

  it('200 { catalog_item_id, active:false }', async () => {
    mockDeactivateCatalog.mockResolvedValueOnce(undefined);
    const res = mockRes();
    await disableCatalogQrController(mockReq({ body: { catalog_item_id: 'i1' } }), res);
    expect(res.body).toEqual({ catalog_item_id: 'i1', active: false });
  });

  it('500 unable_to_disable_qr quando falha', async () => {
    mockDeactivateCatalog.mockRejectedValueOnce(new Error('db'));
    const res = mockRes();
    await disableCatalogQrController(mockReq({ body: { catalog_item_id: 'i1' } }), res);
    expect(res.statusCode).toBe(500);
    expect(errorOf(res)).toBe('unable_to_disable_qr');
  });
});
