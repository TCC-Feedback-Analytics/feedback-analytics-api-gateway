import type { IaAnalyzeEnterpriseContext } from '@feedback/lib-shared/interfaces/contracts/ia-analyze/input.contract';

export type CompanyQuestionSuggestion = { question_order: 1 | 2 | 3; question_text: string };
export type CompanyQuestionSuggestionsResponse = {
  questions: [CompanyQuestionSuggestion, CompanyQuestionSuggestion, CompanyQuestionSuggestion];
};
export type CompanyQuestionSuggestionsRequest = { enterprise_context: IaAnalyzeEnterpriseContext };
