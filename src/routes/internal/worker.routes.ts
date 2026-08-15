import { Router } from 'express';
import { workerTickController } from '../../controllers/internal/worker.controller.js';

const router = Router();

// Montado sob '/api' no index.ts → path final /api/internal/worker/tick.
// (Precisa ficar sob /api para ser roteado pela função serverless na Vercel.)
router.post('/internal/worker/tick', workerTickController);

export default router;
