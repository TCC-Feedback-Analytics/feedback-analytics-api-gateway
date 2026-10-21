import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import {
  analyzeRawFeedbacksController,
  regenerateFeedbackInsightsController,
  getIaJobController,
  listActiveIaJobsController,
  getLatestCompanyQuestionsJobController,
  retryCompanyQuestionsController,
  dismissCompanyQuestionsFailureController,
} from '../../controllers/protected/iaAnalyze.controller.js';
import {
  requestScopeDiagnosisController,
  getLatestScopeDiagnosisController,
  listScopeDiagnosesController,
  getScopeDiagnosisController,
} from '../../controllers/protected/scopeDiagnosis.controller.js';

const router = Router();

router.post('/protected/ia-analyze/analyze-raw', requireAuth, analyzeRawFeedbacksController);
router.post('/protected/ia-analyze/regenerate-insights', requireAuth, regenerateFeedbackInsightsController);
router.get('/protected/ia-analyze/jobs', requireAuth, listActiveIaJobsController);
router.get('/protected/ia-analyze/jobs/company-questions/latest', requireAuth, getLatestCompanyQuestionsJobController);
router.post('/protected/ia-analyze/jobs/company-questions/retry', requireAuth, retryCompanyQuestionsController);
router.post('/protected/ia-analyze/jobs/company-questions/dismiss', requireAuth, dismissCompanyQuestionsFailureController);
router.get('/protected/ia-analyze/jobs/:id', requireAuth, getIaJobController);

// Diagnóstico do escopo com IA: /latest antes de /:id.
router.post('/protected/ia-analyze/scope-diagnosis', requireAuth, requestScopeDiagnosisController);
router.get('/protected/ia-analyze/scope-diagnosis', requireAuth, listScopeDiagnosesController);
router.get('/protected/ia-analyze/scope-diagnosis/latest', requireAuth, getLatestScopeDiagnosisController);
router.get('/protected/ia-analyze/scope-diagnosis/:id', requireAuth, getScopeDiagnosisController);

export default router;
