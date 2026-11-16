import type express from 'express';
import { API_ERROR_RATE_LIMITED } from '../auth/errorMap.js';
import { sendTypedError } from './sendTypedError.js';

/** 429 tipado, com o tempo de espera no corpo e no cabeçalho Retry-After. */
export function sendRateLimited(res: express.Response, retryAfterSeconds: number, message: string) {
  res.setHeader('Retry-After', String(retryAfterSeconds));
  return sendTypedError(res, 429, API_ERROR_RATE_LIMITED, { message, retryAfterSeconds });
}
