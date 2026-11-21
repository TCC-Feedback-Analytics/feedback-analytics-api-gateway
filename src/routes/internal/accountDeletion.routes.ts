import { Router } from 'express';
import { purgeAccountsController } from '../../controllers/internal/accountDeletion.controller.js';

const router = Router();

// Montado sob '/api' no index.ts → path final /api/internal/account-deletions/purge.
router.post('/internal/account-deletions/purge', purgeAccountsController);

export default router;
