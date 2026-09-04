import type { IaAnalyzeInsights } from '@feedback/lib-shared/interfaces/contracts/ia-analyze/analysis.contract';
import type { IaAnalyzeEnterpriseContext } from '@feedback/lib-shared/interfaces/contracts/ia-analyze/input.contract';
import type { IaAnalyzeScopeType } from '@feedback/lib-shared/interfaces/contracts/ia-analyze/scope.contract';

export type IaInsightsSynthesisRequest = {
  enterprise_context: IaAnalyzeEnterpriseContext;
  scope_type: IaAnalyzeScopeType;
  catalog_item_id: string | null;
  catalog_item_name: string | null;
  analyzed_count: number;
  partial_insights: IaAnalyzeInsights[];
};

export type IaInsightsSynthesisResponse = { global_insights: IaAnalyzeInsights };
