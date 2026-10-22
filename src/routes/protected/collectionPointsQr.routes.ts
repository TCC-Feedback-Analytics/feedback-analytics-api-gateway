import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import {
  getQrStatusController,
  enableQrController,
  disableQrController,
  getQrCatalogController,
  upsertCatalogQuestionsController,
  enableCatalogQrController,
  disableCatalogQrController,
} from '../../controllers/protected/collectionPointsQr.controller.js';
import { getCommentFieldController, putCommentFieldController } from '../../controllers/protected/commentField.controller.js';

const router = Router();

router.get('/protected/user/collection-points/qr/status', requireAuth, getQrStatusController);
router.post('/protected/user/collection-points/qr/enable', requireAuth, enableQrController);
router.post('/protected/user/collection-points/qr/disable', requireAuth, disableQrController);
router.get('/protected/user/collection-points/qr/catalog', requireAuth, getQrCatalogController);
router.post('/protected/user/collection-points/qr/catalog/questions/upsert', requireAuth, upsertCatalogQuestionsController);
router.post('/protected/user/collection-points/qr/catalog/enable', requireAuth, enableCatalogQrController);
router.post('/protected/user/collection-points/qr/catalog/disable', requireAuth, disableCatalogQrController);
router.get('/protected/user/collection-points/comment-field', requireAuth, getCommentFieldController);
router.put('/protected/user/collection-points/comment-field', requireAuth, putCommentFieldController);

export default router;
