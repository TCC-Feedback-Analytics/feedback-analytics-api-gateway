import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../index.js';
import { fetchActiveQuestionsForScope } from '../repositories/publicQuestions.repository.js';
import {
  getPublicEnterpriseById,
  resolveQrCollectionPoint,
} from '../repositories/publicEnterprise.repository.js';
import {
  QrFeedbackWriteError,
  findCustomerByEmail,
  findTrackedDevice,
  hasFeedbackSince,
  insertCustomer,
  persistQrFeedback,
  updateTrackedDeviceCounters,
} from '../repositories/qrFeedback.repository.js';

// fetchActiveQuestionsForScope virou Drizzle (coberto por integração) — mockado.
vi.mock('../repositories/publicQuestions.repository.js', () => ({
  fetchActiveQuestionsForScope: vi.fn(),
}));

// Reader (enterprise.controller) virou Drizzle via publicEnterprise.repository —
// coberto por integração; aqui é mockado.
vi.mock('../repositories/publicEnterprise.repository.js', () => ({
  getPublicEnterpriseById: vi.fn(),
  resolveQrCollectionPoint: vi.fn(),
}));

// Submit (qrcode.controller) virou Drizzle+transação via qrFeedback.repository —
// coberto por integração; aqui só mockamos as funções (mantendo o QrFeedbackWriteError real).
vi.mock('../repositories/qrFeedback.repository.js', async (importActual) => {
  const actual = await importActual<typeof import('../repositories/qrFeedback.repository.js')>();
  return {
    ...actual,
    findTrackedDevice: vi.fn(),
    hasFeedbackSince: vi.fn(),
    findCustomerByEmail: vi.fn(),
    insertCustomer: vi.fn(),
    persistQrFeedback: vi.fn(),
    updateTrackedDeviceCounters: vi.fn(),
  };
});

const mockFetchQuestions = vi.mocked(fetchActiveQuestionsForScope);
const mockGetPublicEnterprise = vi.mocked(getPublicEnterpriseById);
const mockResolveQrCollectionPoint = vi.mocked(resolveQrCollectionPoint);
const mockFindTrackedDevice = vi.mocked(findTrackedDevice);
const mockHasFeedbackSince = vi.mocked(hasFeedbackSince);
const mockFindCustomerByEmail = vi.mocked(findCustomerByEmail);
const mockInsertCustomer = vi.mocked(insertCustomer);
const mockPersistQrFeedback = vi.mocked(persistQrFeedback);
const mockUpdateCounters = vi.mocked(updateTrackedDeviceCounters);

const ENTERPRISE_ID = '550e8400-e29b-41d4-a716-446655440001';
const COLLECTION_POINT_ID = '550e8400-e29b-41d4-a716-446655440002';
const Q1_ID = '550e8400-e29b-41d4-a716-446655440010';
const Q2_ID = '550e8400-e29b-41d4-a716-446655440011';
const Q3_ID = '550e8400-e29b-41d4-a716-446655440012';

const VALID_QUESTIONS = [
  { id: Q1_ID, question_order: 1, question_text: 'Pergunta 1', subquestions: [] },
  { id: Q2_ID, question_order: 2, question_text: 'Pergunta 2', subquestions: [] },
  { id: Q3_ID, question_order: 3, question_text: 'Pergunta 3', subquestions: [] },
];

const VALID_ANSWERS = [
  { question_id: Q1_ID, answer_value: 'OTIMA' },
  { question_id: Q2_ID, answer_value: 'BOA' },
  { question_id: Q3_ID, answer_value: 'MEDIANA' },
];

const VALID_PAYLOAD = {
  enterprise_id: ENTERPRISE_ID,
  collection_point_id: COLLECTION_POINT_ID,
  channel: 'QRCODE',
  rating: 5,
  message: 'Ótimo atendimento!',
  answers: VALID_ANSWERS,
  subanswers: [],
};

const CATALOG_ITEM_ID = '550e8400-e29b-41d4-a716-446655440003';

const SINGLE_QUESTION = {
  id: Q1_ID,
  question_order: 1,
  question_text: 'Pergunta 1',
  subquestions: [],
};

describe('[Integração] POST /api/public/qrcode/feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Defaults do caminho feliz "empresa Geral, dispositivo novo"; cada teste sobrescreve o que precisa.
    mockFetchQuestions.mockResolvedValue({ data: [], error: null } as never);
    mockGetPublicEnterprise.mockResolvedValue({ id: ENTERPRISE_ID, name: 'Empresa Teste' });
    mockResolveQrCollectionPoint.mockResolvedValue({
      id: COLLECTION_POINT_ID,
      name: 'QR Geral',
      catalogItemId: null,
      catalogItemName: null,
      catalogItemKind: null,
    });
    mockFindTrackedDevice.mockResolvedValue(null);
    mockHasFeedbackSince.mockResolvedValue(false);
    mockFindCustomerByEmail.mockResolvedValue(null);
    mockInsertCustomer.mockResolvedValue({ id: 'customer-id' });
    mockPersistQrFeedback.mockResolvedValue({ trackedDeviceId: 'new-device-id', priorFeedbackCount: 0 });
    mockUpdateCounters.mockResolvedValue(undefined);
  });

  it('[CT-UC04-02] retorna 400 com payload inválido (sem enterprise_id e channel)', async () => {
    const res = await request(app)
      .post('/api/public/qrcode/feedback')
      .send({ rating: 5, message: 'Teste' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_payload');
  });

  it('[CT-UC04-02] retorna 404 quando empresa não encontrada', async () => {
    mockGetPublicEnterprise.mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/api/public/qrcode/feedback')
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('enterprise_not_found');
    expect(mockPersistQrFeedback).not.toHaveBeenCalled();
  });

  it('[CT-UC04-03] retorna 409 quando dispositivo já enviou feedback hoje', async () => {
    mockFetchQuestions.mockResolvedValueOnce({ data: VALID_QUESTIONS, error: null } as never);
    mockFindTrackedDevice.mockResolvedValueOnce({
      id: 'device-id-1',
      lastFeedbackAt: new Date().toISOString(),
      isBlocked: false,
      feedbackCount: 1,
      customerId: null,
    });
    mockHasFeedbackSince.mockResolvedValueOnce(true);

    const res = await request(app)
      .post('/api/public/qrcode/feedback')
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('DEVICE_ALREADY_SUBMITTED');
    // Nada é gravado quando o dispositivo já enviou hoje.
    expect(mockPersistQrFeedback).not.toHaveBeenCalled();
  });

  it('[CT-UC04-07] retorna 403 quando dispositivo está bloqueado', async () => {
    mockFetchQuestions.mockResolvedValueOnce({ data: VALID_QUESTIONS, error: null } as never);
    mockFindTrackedDevice.mockResolvedValueOnce({
      id: 'device-blocked',
      lastFeedbackAt: null,
      isBlocked: true,
      feedbackCount: 0,
      customerId: null,
    });

    const res = await request(app)
      .post('/api/public/qrcode/feedback')
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(403);
    expect(mockHasFeedbackSince).not.toHaveBeenCalled();
    expect(mockPersistQrFeedback).not.toHaveBeenCalled();
  });

  it('[CT-UC04-01] retorna 200 no caminho feliz (novo dispositivo)', async () => {
    mockFetchQuestions.mockResolvedValueOnce({ data: VALID_QUESTIONS, error: null } as never);

    const res = await request(app)
      .post('/api/public/qrcode/feedback')
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockPersistQrFeedback).toHaveBeenCalledTimes(1);
    const arg = mockPersistQrFeedback.mock.calls[0][0];
    expect(arg.trackedDevice).toBeNull();
    expect(arg.answerRows).toHaveLength(3);
    expect(arg.subanswerRows).toHaveLength(0);
    // contadores best-effort atualizados após a transação.
    expect(mockUpdateCounters).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'new-device-id', feedbackCount: 1 }),
    );
  });

  it('[CT-UC04-05] aceita 1 pergunta no escopo do item (sem fallback para Geral)', async () => {
    mockResolveQrCollectionPoint.mockResolvedValueOnce({
      id: COLLECTION_POINT_ID,
      name: 'QR Produto',
      catalogItemId: CATALOG_ITEM_ID,
      catalogItemName: 'Produto X',
      catalogItemKind: 'PRODUCT',
    });
    mockFetchQuestions.mockResolvedValueOnce({ data: [SINGLE_QUESTION], error: null } as never);

    const res = await request(app)
      .post('/api/public/qrcode/feedback')
      .send({
        enterprise_id: ENTERPRISE_ID,
        collection_point_id: COLLECTION_POINT_ID,
        catalog_item_id: CATALOG_ITEM_ID,
        channel: 'QRCODE',
        rating: 4,
        message: 'Produto muito bom!',
        answers: [{ question_id: Q1_ID, answer_value: 'BOA' }],
        subanswers: [],
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockPersistQrFeedback.mock.calls[0][0].answerRows).toHaveLength(1);
  });

  it('[CT-UC04-06] aceita 0 perguntas (apenas nota + mensagem)', async () => {
    // mockFetchQuestions default = [] (nenhuma pergunta ativa)
    const res = await request(app)
      .post('/api/public/qrcode/feedback')
      .send({
        enterprise_id: ENTERPRISE_ID,
        collection_point_id: COLLECTION_POINT_ID,
        channel: 'QRCODE',
        rating: 5,
        message: 'Atendimento excelente!',
        answers: [],
        subanswers: [],
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockPersistQrFeedback.mock.calls[0][0].answerRows).toHaveLength(0);
  });

  // ---- Contrato dos erros 500 (mapeamento erro-de-repo → código HTTP tipado) ----

  it('[500] collection_point_error quando resolveQrCollectionPoint falha', async () => {
    mockResolveQrCollectionPoint.mockRejectedValueOnce(new Error('db down'));

    const res = await request(app)
      .post('/api/public/qrcode/feedback')
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('collection_point_error');
    expect(mockPersistQrFeedback).not.toHaveBeenCalled();
  });

  it('[500] device_check_failed quando findTrackedDevice falha', async () => {
    mockFetchQuestions.mockResolvedValueOnce({ data: VALID_QUESTIONS, error: null } as never);
    mockFindTrackedDevice.mockRejectedValueOnce(new Error('db down'));

    const res = await request(app)
      .post('/api/public/qrcode/feedback')
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('device_check_failed');
    expect(mockPersistQrFeedback).not.toHaveBeenCalled();
  });

  it('[500] device_check_failed quando hasFeedbackSince falha', async () => {
    mockFetchQuestions.mockResolvedValueOnce({ data: VALID_QUESTIONS, error: null } as never);
    mockFindTrackedDevice.mockResolvedValueOnce({
      id: 'device-existente',
      lastFeedbackAt: null,
      isBlocked: false,
      feedbackCount: 0,
      customerId: null,
    });
    mockHasFeedbackSince.mockRejectedValueOnce(new Error('db down'));

    const res = await request(app)
      .post('/api/public/qrcode/feedback')
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('device_check_failed');
    expect(mockPersistQrFeedback).not.toHaveBeenCalled();
  });

  it('[500] device_creation_failed quando persist lança QrFeedbackWriteError(device_creation)', async () => {
    mockFetchQuestions.mockResolvedValueOnce({ data: VALID_QUESTIONS, error: null } as never);
    mockPersistQrFeedback.mockRejectedValueOnce(new QrFeedbackWriteError('device_creation'));

    const res = await request(app)
      .post('/api/public/qrcode/feedback')
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('device_creation_failed');
  });

  it('[500] feedback_insert_failed quando persist lança QrFeedbackWriteError(feedback_insert)', async () => {
    mockFetchQuestions.mockResolvedValueOnce({ data: VALID_QUESTIONS, error: null } as never);
    mockPersistQrFeedback.mockRejectedValueOnce(new QrFeedbackWriteError('feedback_insert'));

    const res = await request(app)
      .post('/api/public/qrcode/feedback')
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('feedback_insert_failed');
  });

  it('[500] feedback_insert_failed no fallback (erro genérico do persist)', async () => {
    mockFetchQuestions.mockResolvedValueOnce({ data: VALID_QUESTIONS, error: null } as never);
    mockPersistQrFeedback.mockRejectedValueOnce(new Error('erro inesperado'));

    const res = await request(app)
      .post('/api/public/qrcode/feedback')
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('feedback_insert_failed');
  });
});

describe('[Integração] GET /api/public/enterprise/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // default: nenhuma pergunta; testes específicos sobrescrevem com mockResolvedValueOnce.
    mockFetchQuestions.mockResolvedValue({ data: [], error: null } as never);
    mockResolveQrCollectionPoint.mockResolvedValue(null);
  });

  it('retorna 200 com dados públicos da empresa', async () => {
    mockGetPublicEnterprise.mockResolvedValueOnce({ id: ENTERPRISE_ID, name: 'Empresa Teste' });
    mockResolveQrCollectionPoint.mockResolvedValueOnce({
      id: COLLECTION_POINT_ID,
      name: 'QR Geral',
      catalogItemId: null,
      catalogItemName: null,
      catalogItemKind: null,
    });

    const res = await request(app).get(`/api/public/enterprise/${ENTERPRISE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: ENTERPRISE_ID,
      name: 'Empresa Teste',
      collection_point_id: COLLECTION_POINT_ID,
      catalog_item_id: null,
      item_kind: null,
      questions: [],
    });
  });

  it('[CT-UC04-02] retorna 404 quando empresa não encontrada', async () => {
    mockGetPublicEnterprise.mockResolvedValueOnce(null);

    const res = await request(app).get('/api/public/enterprise/id-inexistente');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('enterprise_not_found');
  });
});
