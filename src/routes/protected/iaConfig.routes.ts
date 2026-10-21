import { Router, type RequestHandler } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import {
  getIaConfigController,
  putIaConfigController,
  deleteIaConfigController,
  getIaModelsController,
  patchIaModelController,
  connectOpenRouterController,
} from '../../controllers/protected/iaConfig.controller.js';

const router = Router();
const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
};

router.get('/protected/user/ia-config', noStore, requireAuth, getIaConfigController);
router.put('/protected/user/ia-config', noStore, requireAuth, putIaConfigController);
router.delete('/protected/user/ia-config', noStore, requireAuth, deleteIaConfigController);
router.get('/protected/user/ia-models', noStore, requireAuth, getIaModelsController);
router.patch('/protected/user/ia-config/model', noStore, requireAuth, patchIaModelController);
router.post('/protected/user/ia-config/openrouter/connect', noStore, requireAuth, connectOpenRouterController);

export default router;
