import { fetchEnterpriseContextForAnalysis } from '../repositories/iaAnalyze.repository.js';
import { getIaConfigByEnterprise } from '../repositories/iaConfig.repository.js';
import { resolveIaCredsForEnterprise } from '../libs/iaConfig/resolveIaCreds.js';
import { buildEnterpriseContext } from '../libs/iaAnalyze/build.js';
import { companyQuestionContextSchema } from '../libs/iaAnalyze/companyQuestions.js';
import { IaAnalyzeServiceError } from '../libs/iaAnalyze/errors.js';
import { enqueueCompanyQuestionSuggestions } from '../repositories/companyQuestionSuggestions.repository.js';
import type { IaCreds } from '../providers/iaAnalyze.provider.js';

export async function requestCompanyQuestionSuggestions(enterpriseId: string, userId: string) {
  const source = await fetchEnterpriseContextForAnalysis({ enterpriseId });
  const context = companyQuestionContextSchema.safeParse(buildEnterpriseContext(source));
  if (!context.success) throw new IaAnalyzeServiceError('company_context_required', 422, 'company_context_required');
  const config = await getIaConfigByEnterprise(enterpriseId);
  if (!config?.apiKeyCiphertext || !config.apiKeyIv || !config.apiKeyAuthTag || !config.model?.trim()
    || !['openrouter', 'gemini'].includes(config.provider)) {
    throw new IaAnalyzeServiceError('ia_config_required', 409, 'ia_config_required');
  }
  return enqueueCompanyQuestionSuggestions({ enterpriseId, requestedBy: userId, context: context.data });
}

export async function resolveCompanyQuestionCreds(enterpriseId: string): Promise<IaCreds> {
  const creds = await resolveIaCredsForEnterprise(enterpriseId);
  if (!creds?.apiKey?.trim() || !creds.model?.trim() || !['openrouter', 'gemini'].includes(creds.provider)) {
    throw new IaAnalyzeServiceError('ia_config_required', 409, 'ia_config_required');
  }
  return creds;
}
