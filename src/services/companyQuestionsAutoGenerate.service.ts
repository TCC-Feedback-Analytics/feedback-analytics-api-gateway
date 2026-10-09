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
import { getLatestCompanyQuestionsJobStatus } from '../repositories/companyQuestionSuggestions.repository.js';
import { hasDefaultCompanyQuestions } from '../repositories/collectingData.repository.js';
import { requestCompanyQuestionSuggestions } from './companyQuestionSuggestions.service.js';

/** Nunca lança: uma falha aqui não pode quebrar o salvamento do perfil. */
export async function autoGenerateCompanyQuestions(enterpriseId: string, userId: string): Promise<void> {
  try {
    const latest = await getLatestCompanyQuestionsJobStatus(enterpriseId);
    if (latest === 'completed') return;
    if (latest) {
      // Já existe pedido na fila: só garante que ele ande.
      kickWorkerIfPending(enterpriseId);
      return;
    }
    // A empresa já personalizou as perguntas: a IA não interfere.
    if (!(await hasDefaultCompanyQuestions(enterpriseId))) return;

    await requestCompanyQuestionSuggestions(enterpriseId, userId);
    kickWorker();
  } catch (error) {
    // Contexto incompleto, IA não configurada, cooldown ou limite diário: segue sem gerar.
    if (error instanceof IaAnalyzeServiceError) return;
    console.error('[company-questions:auto] falha ao enfileirar geração:', error);
  }
}
