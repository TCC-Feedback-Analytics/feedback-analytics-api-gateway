import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../index.js';
import { commentFieldAdvice } from '@feedback/lib-shared/schemas/public/commentField';
import { resolveEnterpriseIdByUser } from '../repositories/enterprise.repository.js';
import { fetchCatalogItemsByIds } from '../repositories/feedbackList.repository.js';
import { fetchCommentField, upsertCommentField } from '../repositories/commentField.repository.js';
import { toDiagnosisCommentField } from '../libs/scopeDiagnosis.js';
import type { ScopedStats } from '../services/scopeMetrics.service.js';

const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';
const ENTERPRISE_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const ITEM_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const ROUTE = '/api/protected/user/collection-points/comment-field';

vi.mock('../middlewares/auth.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: TEST_USER_ID };
    next();
  },
}));
vi.mock('../repositories/enterprise.repository.js', () => ({ resolveEnterpriseIdByUser: vi.fn() }));
vi.mock('../repositories/feedbackList.repository.js', () => ({ fetchCatalogItemsByIds: vi.fn() }));
vi.mock('../repositories/commentField.repository.js', () => ({
  fetchCommentField: vi.fn(),
  upsertCommentField: vi.fn(),
  fetchScopeCommentField: vi.fn(),
}));

describe('[Integração] campo de comentário por escopo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveEnterpriseIdByUser).mockResolvedValue(ENTERPRISE_ID);
    vi.mocked(fetchCatalogItemsByIds).mockResolvedValue([{ id: ITEM_ID, name: 'Pão de queijo', kind: 'PRODUCT' }]);
    vi.mocked(fetchCommentField).mockResolvedValue({ mode: 'DEFAULT', prompt: null });
    vi.mocked(upsertCommentField).mockImplementation(async (_id, payload) => ({ mode: payload.mode, prompt: payload.prompt }));
  });

  it('lê o campo da empresa', async () => {
    const res = await request(app).get(`${ROUTE}?scope_type=COMPANY`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: 'DEFAULT', prompt: null });
    expect(fetchCommentField).toHaveBeenCalledWith({ enterpriseId: ENTERPRISE_ID, scopeType: 'COMPANY', catalogItemId: null });
  });

  it('não lê item de outro tipo ou de outra empresa', async () => {
    vi.mocked(fetchCatalogItemsByIds).mockResolvedValueOnce([]);
    const res = await request(app).get(`${ROUTE}?scope_type=PRODUCT&catalog_item_id=${ITEM_ID}`);
    expect(res.status).toBe(404);
    expect(fetchCommentField).not.toHaveBeenCalled();
  });

  it('salva a pergunta própria de um item', async () => {
    const res = await request(app).put(ROUTE).send({
      scope_type: 'PRODUCT', catalog_item_id: ITEM_ID, mode: 'CUSTOM', prompt: '  O que mudaria neste produto?  ',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: 'CUSTOM', prompt: 'O que mudaria neste produto?' });
    expect(upsertCommentField).toHaveBeenCalledWith(ENTERPRISE_ID, {
      scope_type: 'PRODUCT', catalog_item_id: ITEM_ID, mode: 'CUSTOM', prompt: 'O que mudaria neste produto?',
    });
  });

  it('ocultar descarta a pergunta enviada junto', async () => {
    await request(app).put(ROUTE).send({ scope_type: 'COMPANY', mode: 'HIDDEN', prompt: 'Qualquer pergunta aqui' });
    expect(upsertCommentField).toHaveBeenCalledWith(ENTERPRISE_ID, {
      scope_type: 'COMPANY', catalog_item_id: null, mode: 'HIDDEN', prompt: null,
    });
  });

  it('recusa pergunta própria vazia ou curta e item na empresa', async () => {
    const short = await request(app).put(ROUTE).send({ scope_type: 'COMPANY', mode: 'CUSTOM', prompt: 'Oi?' });
    const empty = await request(app).put(ROUTE).send({ scope_type: 'COMPANY', mode: 'CUSTOM' });
    const companyWithItem = await request(app).put(ROUTE).send({ scope_type: 'COMPANY', catalog_item_id: ITEM_ID, mode: 'DEFAULT' });
    const itemWithoutId = await request(app).put(ROUTE).send({ scope_type: 'SERVICE', mode: 'DEFAULT' });
    expect([short.status, empty.status, companyWithItem.status, itemWithoutId.status]).toEqual([400, 400, 400, 400]);
    expect(upsertCommentField).not.toHaveBeenCalled();
  });
});

describe('quando sugerir mudar o campo de comentário', () => {
  const participation = (total: number, withComment: number, shortComments = 0) => ({
    total, withComment, pct: Math.round((withComment / total) * 1000) / 10, shortComments,
  });
  const visible = { hidden: 'none' as const, prompt: null };

  it('com poucas avaliações, não sugere nada', () => {
    expect(commentFieldAdvice(participation(19, 1), visible)).toBeNull();
  });

  it('poucos comentam: sugere ajustar o campo', () => {
    expect(commentFieldAdvice(participation(40, 5), visible)).toBe('low_participation');
    expect(commentFieldAdvice(participation(40, 6), visible)).toBeNull();
  });

  it('comentários quase sempre curtos: sugere uma pergunta própria', () => {
    expect(commentFieldAdvice(participation(40, 20, 12), visible)).toBe('low_content');
    expect(commentFieldAdvice(participation(40, 20, 11), visible)).toBeNull();
  });

  it('com o campo oculto em todo o recorte, não sugere nada', () => {
    expect(commentFieldAdvice(participation(40, 0), { hidden: 'all', prompt: null })).toBeNull();
  });

  it('o diagnóstico leva o campo e a sugestão para a IA', () => {
    const stats = {
      commentParticipation: { ...participation(40, 4), ci: { lower: 0, upper: 0 }, confidenceTier: 'good', withCommentRating: null, withoutCommentRating: null },
      commentField: { hidden: 'some', prompt: null },
    } as unknown as ScopedStats;
    expect(toDiagnosisCommentField(stats)).toEqual({ hidden: 'some', prompt: null, advice: 'low_participation' });
  });
});
