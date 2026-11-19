/**
 * Limite de envios do formulário público por IP, contado no banco (tabela
 * `auth_rate_limit`) como o do login. O limite por aparelho e dia sozinho não segura
 * um script que troca o cabeçalho do navegador a cada envio: o IP continua o mesmo.
 *
 * O padrão é largo (60 envios a cada 15 minutos) porque vários clientes de um mesmo
 * estabelecimento podem responder pela mesma rede Wi-Fi.
 */
import { getDb } from '../db/client.js';
import {
  authFingerprint,
  consumeQuota,
  deleteExpiredQuotas,
  normalizeClientIp,
  positiveEnv,
  type RateLimitReservation,
} from './authRateLimit.js';

export async function reservePublicFeedbackSubmission(ip: string): Promise<RateLimitReservation> {
  const max = positiveEnv('PUBLIC_FEEDBACK_IP_MAX', 60);
  const windowSeconds = positiveEnv('PUBLIC_FEEDBACK_IP_WINDOW_SECONDS', 900);
  const key = `public-feedback:ip:${authFingerprint('public-feedback', 'ip', normalizeClientIp(ip))}`;

  const result = await consumeQuota(getDb(), key, max, windowSeconds);
  await deleteExpiredQuotas('public-feedback-rate-limit');
  return { allowed: result.allowed, retryAfterSeconds: result.allowed ? 0 : result.retry };
}
