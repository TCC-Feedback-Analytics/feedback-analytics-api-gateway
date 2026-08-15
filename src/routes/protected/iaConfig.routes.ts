import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import {
  getIaConfigController,
  putIaConfigController,
  deleteIaConfigController,
} from '../../controllers/protected/iaConfig.controller.js';

const router = Router();

router.get('/protected/user/ia-config', requireAuth, getIaConfigController);
router.put('/protected/user/ia-config', requireAuth, putIaConfigController);
router.delete('/protected/user/ia-config', requireAuth, deleteIaConfigController);

export default router;
