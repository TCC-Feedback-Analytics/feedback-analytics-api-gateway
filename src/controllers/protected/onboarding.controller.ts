import type { Request, Response } from 'express';
import { z } from 'zod';
import { getSystemGuide, finishSystemGuide, SYSTEM_GUIDE_KEY, SYSTEM_GUIDE_VERSION } from '../../repositories/onboarding.repository.js';
import { sendTypedError } from '../../utils/sendTypedError.js';
import { API_ERROR_INVALID_PAYLOAD, API_ERROR_INTERNAL_ERROR } from '../../config/errors.js';

const finishSchema = z.object({
  version: z.literal(SYSTEM_GUIDE_VERSION),
  status: z.enum(['completed', 'skipped']),
}).strict();

function response(row: Awaited<ReturnType<typeof getSystemGuide>>) {
  return {
    tourKey: SYSTEM_GUIDE_KEY,
    version: SYSTEM_GUIDE_VERSION,
    status: row?.status ?? 'pending',
    finishedAt: row?.finishedAt.toISOString() ?? null,
  };
}

export async function getSystemGuideController(req: Request, res: Response) {
  res.set('Cache-Control', 'no-store');
  try {
    return res.json(response(await getSystemGuide(req.user!.id)));
  } catch {
    return sendTypedError(res, 500, API_ERROR_INTERNAL_ERROR);
  }
}

export async function putSystemGuideController(req: Request, res: Response) {
  res.set('Cache-Control', 'no-store');
  const parsed = finishSchema.safeParse(req.body);
  if (!parsed.success) return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD);
  try {
    return res.json(response(await finishSystemGuide(req.user!.id, parsed.data.status)));
  } catch {
    return sendTypedError(res, 500, API_ERROR_INTERNAL_ERROR);
  }
}
