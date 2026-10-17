/**
 * Configuração inicial: assim que a empresa tem os 3 campos de contexto e a IA
 * (chave + modelo) configurada, as 3 perguntas do feedback geral são geradas por
 * dentro, sem botão nem tela de sugestões. O worker aplica o resultado se as
 * perguntas ainda forem as padrão (`applyCompanyQuestionsIfDefault`).
 *
 * Arquivo separado do companyQuestionSuggestions.service porque o worker importa
 * aquele service, e este importa o disparo do worker.
 */
import { IaAnalyzeServiceError } from '../libs/iaAnalyze/errors.js';
import { kickWorker, kickWorkerIfPending } from '../libs/iaJob/kickWorker.js';
import {
  getLatestCompanyQuestionsJobStatus,
  QuestionSuggestionsRateLimitError,
} from '../repositories/companyQuestionSuggestions.repository.js';
import { hasDefaultCompanyQuestions } from '../repositories/collectingData.repository.js';
import { requestCompanyQuestionSuggestions } from './companyQuestionSuggestions.service.js';

/**
 * O que aconteceu com o pedido de geração, para a Web dizer a verdade ao usuário
 * (ex.: depois de trocar o modelo ou de "Tentar de novo"):
 * - queued: um pedido novo foi para a fila;
 * - running: já havia um pedido andando (só foi acionado);
 * - completed: as perguntas já foram geradas antes;
 * - customized: a empresa já editou as perguntas, a IA não interfere;
 * - rate_limited: intervalo entre pedidos ou limite diário; `retryAfterSeconds` diz quanto falta;
 * - unavailable: contexto incompleto ou IA não configurada (`code` diz qual).
 */
export type CompanyQuestionsGenerationResult =
  | { status: 'queued' | 'running' | 'completed' | 'customized' }
  | { status: 'rate_limited'; retryAfterSeconds: number }
  | { status: 'unavailable'; code: string };

/** Nunca lança: uma falha aqui não pode quebrar o salvamento do perfil. */
export async function autoGenerateCompanyQuestions(
  enterpriseId: string,
  userId: string,
): Promise<CompanyQuestionsGenerationResult> {
  try {
    const latest = await getLatestCompanyQuestionsJobStatus(enterpriseId);
    if (latest === 'completed') return { status: 'completed' };
    if (latest) {
      // Já existe pedido na fila: só garante que ele ande.
      kickWorkerIfPending(enterpriseId);
      return { status: 'running' };
    }
    // A empresa já personalizou as perguntas: a IA não interfere.
    if (!(await hasDefaultCompanyQuestions(enterpriseId))) return { status: 'customized' };

    await requestCompanyQuestionSuggestions(enterpriseId, userId);
    kickWorker();
    return { status: 'queued' };
  } catch (error) {
    if (error instanceof QuestionSuggestionsRateLimitError) {
      return { status: 'rate_limited', retryAfterSeconds: error.retryAfterSeconds };
    }
    // Contexto incompleto ou IA não configurada: segue sem gerar.
    if (error instanceof IaAnalyzeServiceError) return { status: 'unavailable', code: error.code };
    console.error('[company-questions:auto] falha ao enfileirar geração:', error);
    return { status: 'unavailable', code: 'internal_error' };
  }
}
