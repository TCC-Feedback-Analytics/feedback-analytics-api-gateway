import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import {
  analyzeRawFeedbacksController,
  regenerateFeedbackInsightsController,
  getIaJobController,
  listActiveIaJobsController,
} from '../../controllers/protected/iaAnalyze.controller.js';

const router = Router();

router.post('/protected/ia-analyze/analyze-raw', requireAuth, analyzeRawFeedbacksController);
router.post('/protected/ia-analyze/regenerate-insights', requireAuth, regenerateFeedbackInsightsController);
router.get('/protected/ia-analyze/jobs', requireAuth, listActiveIaJobsController);
router.get('/protected/ia-analyze/jobs/:id', requireAuth, getIaJobController);

export default router;
