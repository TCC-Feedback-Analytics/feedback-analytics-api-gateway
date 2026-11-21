import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { allowPendingDeletion } from '../../middlewares/allowPendingDeletion.js';
import {
  cancelAccountDeletionController,
  confirmAccountDeletionController,
  requestAccountDeletionController,
} from '../../controllers/protected/accountDeletion.controller.js';
import { getSystemGuideController, putSystemGuideController } from '../../controllers/protected/onboarding.controller.js';
import { completeSignupController } from '../../controllers/protected/completeSignup.controller.js';
import {
  getAuthUserController,
  patchUserEmailController,
  patchUserMetadadosController,
  startUserPhoneVerificationController,
  verifyUserPhoneController,
  resetPasswordController,
} from '../../controllers/protected/user.controller.js';

const router = Router();

router.get('/protected/user/onboarding/system-guide', requireAuth, getSystemGuideController);
router.put('/protected/user/onboarding/system-guide', requireAuth, putSystemGuideController);

// Com a exclusão agendada, a Web ainda lê o usuário (para mostrar a data) e pode desistir.
router.get('/protected/user/auth_user', allowPendingDeletion, requireAuth, getAuthUserController);
router.post('/protected/user/account-deletion', requireAuth, requestAccountDeletionController);
router.post('/protected/user/account-deletion/confirm', requireAuth, confirmAccountDeletionController);
router.post('/protected/user/account-deletion/cancel', allowPendingDeletion, requireAuth, cancelAccountDeletionController);
router.patch('/protected/user/email', requireAuth, patchUserEmailController);
router.patch('/protected/user/metadados', requireAuth, patchUserMetadadosController);
// Primeira entrada com Google: nome do negócio, telefone e aceite dos termos.
router.post('/protected/user/complete-signup', requireAuth, completeSignupController);
router.post('/protected/user/phone/start', requireAuth, startUserPhoneVerificationController);
router.post('/protected/user/phone/verify', requireAuth, verifyUserPhoneController);
router.patch('/protected/user/password', requireAuth, resetPasswordController);

export default router;
