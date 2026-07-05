import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../index.js';
import { createSupabaseServerClient } from '../config/supabase.js';
import { fetchActiveQuestionsForScope } from '../repositories/publicQuestions.repository.js';
import {
  getPublicEnterpriseById,
  resolveQrCollectionPoint,
} from '../repositories/publicEnterprise.repository.js';
import { makeMockSupabase } from './helpers/supabase-mock.js';

vi.mock('../config/supabase.js', () => ({
  createSupabaseServerClient: vi.fn(),
}));

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

const mockCreateClient = vi.mocked(createSupabaseServerClient);
const mockFetchQuestions = vi.mocked(fetchActiveQuestionsForScope);
const mockGetPublicEnterprise = vi.mocked(getPublicEnterpriseById);
const mockResolveQrCollectionPoint = vi.mocked(resolveQrCollectionPoint);

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
  let mockSupabase: ReturnType<typeof makeMockSupabase>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase = makeMockSupabase();
    mockCreateClient.mockReturnValue(mockSupabase as never);
    // default: nenhuma pergunta; testes específicos sobrescrevem com mockResolvedValueOnce.
    mockFetchQuestions.mockResolvedValue({ data: [], error: null } as never);
  });

  it('[CT-UC04-02] retorna 400 com payload inválido (sem enterprise_id e channel)', async () => {
    const res = await request(app)
      .post('/api/public/qrcode/feedback')
      .send({ rating: 5, message: 'Teste' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_payload');
  });

  it('[CT-UC04-02] retorna 404 quando empresa não encontrada', async () => {
    mockSupabase.queryBuilder.single.mockResolvedValueOnce({
      data: null,
      error: { message: 'No rows found' },
    });

    const res = await request(app)
      .post('/api/public/qrcode/feedback')
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('enterprise_not_found');
  });

  it('[CT-UC04-03] retorna 409 quando dispositivo já enviou feedback hoje', async () => {
    // enterprise encontrada
    mockSupabase.queryBuilder.single.mockResolvedValueOnce({
      data: { id: ENTERPRISE_ID },
      error: null,
    });

    // collection_point encontrado
    mockSupabase.queryBuilder.maybeSingle.mockResolvedValueOnce({
      data: {
        id: COLLECTION_POINT_ID,
        name: 'QR Geral',
        catalog_item_id: null,
        catalog_items: null,
      },
      error: null,
    });

    // questions (3) via fetchActiveQuestionsForScope (Drizzle, mockado)
    mockFetchQuestions.mockResolvedValueOnce({ data: VALID_QUESTIONS, error: null } as never);

    // device existente
    mockSupabase.queryBuilder.maybeSingle.mockResolvedValueOnce({
      data: {
        id: 'device-id-1',
        last_feedback_at: new Date().toISOString(),
        is_blocked: false,
        feedback_count: 1,
        customer_id: null,
      },
      error: null,
    });

    // feedback duplicado encontrado (hoje)
    mockSupabase.queryBuilder.maybeSingle.mockResolvedValueOnce({
      data: { id: 'feedback-existente' },
      error: null,
    });

    const res = await request(app)
      .post('/api/public/qrcode/feedback')
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('DEVICE_ALREADY_SUBMITTED');
  });

  it('[CT-UC04-01] retorna 200 no caminho feliz (novo dispositivo)', async () => {
    // enterprise encontrada
    mockSupabase.queryBuilder.single.mockResolvedValueOnce({
      data: { id: ENTERPRISE_ID },
      error: null,
    });

    // collection_point encontrado
    mockSupabase.queryBuilder.maybeSingle.mockResolvedValueOnce({
      data: {
        id: COLLECTION_POINT_ID,
        name: 'QR Geral',
        catalog_item_id: null,
        catalog_items: null,
      },
      error: null,
    });

    // questions (3) via fetchActiveQuestionsForScope (Drizzle, mockado)
    mockFetchQuestions.mockResolvedValueOnce({ data: VALID_QUESTIONS, error: null } as never);

    // device não encontrado (novo)
    mockSupabase.queryBuilder.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: null,
    });

    // criação do novo device
    mockSupabase.queryBuilder.single.mockResolvedValueOnce({
      data: {
        id: 'new-device-id',
        feedback_count: 0,
        last_feedback_at: null,
        is_blocked: false,
        customer_id: null,
      },
      error: null,
    });

    // inserção do feedback
    mockSupabase.queryBuilder.then.mockImplementationOnce((resolve: (v: unknown) => void) => {
      resolve({ data: null, error: null });
      return Promise.resolve({ data: null, error: null });
    });

    // inserção das respostas
    mockSupabase.queryBuilder.then.mockImplementationOnce((resolve: (v: unknown) => void) => {
      resolve({ data: null, error: null });
      return Promise.resolve({ data: null, error: null });
    });

    // atualização do device (last_feedback_at, feedback_count)
    mockSupabase.queryBuilder.then.mockImplementationOnce((resolve: (v: unknown) => void) => {
      resolve({ data: null, error: null });
      return Promise.resolve({ data: null, error: null });
    });

    const res = await request(app)
      .post('/api/public/qrcode/feedback')
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('[CT-UC04-05] aceita 1 pergunta no escopo do item (sem fallback para Geral)', async () => {
    // enterprise encontrada
    mockSupabase.queryBuilder.single.mockResolvedValueOnce({
      data: { id: ENTERPRISE_ID },
      error: null,
    });

    // collection_point de PRODUTO encontrado
    mockSupabase.queryBuilder.maybeSingle.mockResolvedValueOnce({
      data: {
        id: COLLECTION_POINT_ID,
        name: 'QR Produto',
        catalog_item_id: CATALOG_ITEM_ID,
        catalog_items: { kind: 'PRODUCT' },
      },
      error: null,
    });

    // apenas 1 pergunta ativa (via fetchActiveQuestionsForScope, mockado)
    mockFetchQuestions.mockResolvedValueOnce({ data: [SINGLE_QUESTION], error: null } as never);

    // device novo
    mockSupabase.queryBuilder.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: null,
    });

    // criação do device
    mockSupabase.queryBuilder.single.mockResolvedValueOnce({
      data: {
        id: 'new-device-id',
        feedback_count: 0,
        last_feedback_at: null,
        is_blocked: false,
        customer_id: null,
      },
      error: null,
    });

    // feedback insert + answers insert + device update
    for (let i = 0; i < 3; i += 1) {
      mockSupabase.queryBuilder.then.mockImplementationOnce((resolve: (v: unknown) => void) => {
        const result = { data: null, error: null };
        resolve(result);
        return Promise.resolve(result);
      });
    }

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
  });

  it('[CT-UC04-06] aceita 0 perguntas (apenas nota + mensagem)', async () => {
    // enterprise encontrada
    mockSupabase.queryBuilder.single.mockResolvedValueOnce({
      data: { id: ENTERPRISE_ID },
      error: null,
    });

    // collection_point Geral (sem item) encontrado
    mockSupabase.queryBuilder.maybeSingle.mockResolvedValueOnce({
      data: {
        id: COLLECTION_POINT_ID,
        name: 'QR Geral',
        catalog_item_id: null,
        catalog_items: null,
      },
      error: null,
    });

    // nenhuma pergunta configurada (default do mockFetchQuestions)

    // device novo
    mockSupabase.queryBuilder.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: null,
    });

    // criação do device
    mockSupabase.queryBuilder.single.mockResolvedValueOnce({
      data: {
        id: 'new-device-id',
        feedback_count: 0,
        last_feedback_at: null,
        is_blocked: false,
        customer_id: null,
      },
      error: null,
    });

    // feedback insert + device update (sem insert de respostas, pois não há respostas)
    for (let i = 0; i < 2; i += 1) {
      mockSupabase.queryBuilder.then.mockImplementationOnce((resolve: (v: unknown) => void) => {
        const result = { data: null, error: null };
        resolve(result);
        return Promise.resolve(result);
      });
    }

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
