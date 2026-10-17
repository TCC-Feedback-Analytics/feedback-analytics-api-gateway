import { vi, describe, it, expect, beforeEach } from 'vitest';
import { autoGenerateCompanyQuestions } from '../services/companyQuestionsAutoGenerate.service.js';
import { getLatestCompanyQuestionsJobStatus, QuestionSuggestionsRateLimitError } from '../repositories/companyQuestionSuggestions.repository.js';
import { hasDefaultCompanyQuestions } from '../repositories/collectingData.repository.js';
import { requestCompanyQuestionSuggestions } from '../services/companyQuestionSuggestions.service.js';
import { kickWorker, kickWorkerIfPending } from '../libs/iaJob/kickWorker.js';
import { IaAnalyzeServiceError } from '../libs/iaAnalyze/errors.js';

vi.mock('../repositories/companyQuestionSuggestions.repository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../repositories/companyQuestionSuggestions.repository.js')>();
  return { QuestionSuggestionsRateLimitError: actual.QuestionSuggestionsRateLimitError, getLatestCompanyQuestionsJobStatus: vi.fn() };
});
vi.mock('../repositories/collectingData.repository.js', () => ({ hasDefaultCompanyQuestions: vi.fn() }));
vi.mock('../services/companyQuestionSuggestions.service.js', () => ({ requestCompanyQuestionSuggestions: vi.fn() }));
vi.mock('../libs/iaJob/kickWorker.js', () => ({ kickWorker: vi.fn(), kickWorkerIfPending: vi.fn() }));

const ENT = 'ent-1';
const USER = 'user-1';
const mLatest = vi.mocked(getLatestCompanyQuestionsJobStatus);
const mDefault = vi.mocked(hasDefaultCompanyQuestions);
const mRequest = vi.mocked(requestCompanyQuestionSuggestions);

beforeEach(() => {
  vi.clearAllMocks();
  mLatest.mockResolvedValue(null);
  mDefault.mockResolvedValue(true);
  mRequest.mockResolvedValue({ jobId: 'job-1', status: 'queued', deduped: false, contextHash: 'h' });
});

describe('autoGenerateCompanyQuestions: diz o que aconteceu', () => {
  it('sem pedido anterior e com perguntas padrão, enfileira e aciona o worker', async () => {
    await expect(autoGenerateCompanyQuestions(ENT, USER)).resolves.toEqual({ status: 'queued' });
    expect(mRequest).toHaveBeenCalledWith(ENT, USER);
    expect(kickWorker).toHaveBeenCalledOnce();
  });

  it('depois de uma falha (último pedido failed não conta), enfileira de novo', async () => {
    mLatest.mockResolvedValue(null);
    await expect(autoGenerateCompanyQuestions(ENT, USER)).resolves.toEqual({ status: 'queued' });
  });

  it('com pedido ativo, só aciona o worker', async () => {
    mLatest.mockResolvedValue('waiting_budget');
    await expect(autoGenerateCompanyQuestions(ENT, USER)).resolves.toEqual({ status: 'running' });
    expect(kickWorkerIfPending).toHaveBeenCalledWith(ENT);
    expect(mRequest).not.toHaveBeenCalled();
  });

  it('já concluído ou perguntas editadas não gera de novo', async () => {
    mLatest.mockResolvedValueOnce('completed');
    await expect(autoGenerateCompanyQuestions(ENT, USER)).resolves.toEqual({ status: 'completed' });
    mDefault.mockResolvedValueOnce(false);
    await expect(autoGenerateCompanyQuestions(ENT, USER)).resolves.toEqual({ status: 'customized' });
    expect(mRequest).not.toHaveBeenCalled();
  });

  it('intervalo ou limite diário volta como rate_limited com o tempo de espera', async () => {
    mRequest.mockRejectedValue(new QuestionSuggestionsRateLimitError(42));
    await expect(autoGenerateCompanyQuestions(ENT, USER)).resolves.toEqual({ status: 'rate_limited', retryAfterSeconds: 42 });
  });

  it('contexto incompleto ou IA sem configurar volta como unavailable com o código', async () => {
    mRequest.mockRejectedValue(new IaAnalyzeServiceError('ia_config_required', 409, 'ia_config_required'));
    await expect(autoGenerateCompanyQuestions(ENT, USER)).resolves.toEqual({ status: 'unavailable', code: 'ia_config_required' });
  });

  it('erro inesperado não lança', async () => {
    mRequest.mockRejectedValue(new Error('db down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(autoGenerateCompanyQuestions(ENT, USER)).resolves.toEqual({ status: 'unavailable', code: 'internal_error' });
    spy.mockRestore();
  });
});
