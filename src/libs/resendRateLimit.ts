import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {
  authFingerprint,
  consumeQuota,
  deleteExpiredQuotas,
  normalizeClientIp,
  positiveEnv,
  type RateLimitReservation,
} from './authRateLimit.js';

export function resendCooldownSeconds(): number {
  return positiveEnv('RESEND_EMAIL_COOLDOWN_SECONDS', 60);
}

export function resendFingerprint(kind: 'ip' | 'email', value: string): string {
  return authFingerprint('resend-confirmation', kind, value);
}

/** IP attempts are counted even when the e-mail is cooling down. All instances share row locks. */
export async function reserveResend(ip: string, email: string): Promise<RateLimitReservation> {
  const cooldown = resendCooldownSeconds();
  const ipLimit = positiveEnv('RESEND_IP_MAX', 20);
  const ipWindow = positiveEnv('RESEND_IP_WINDOW_SECONDS', 900);
  const emailLimit = positiveEnv('RESEND_EMAIL_MAX', 5);
  const emailWindow = positiveEnv('RESEND_EMAIL_WINDOW_SECONDS', 3600);
  const ipKey = `ip:${resendFingerprint('ip', normalizeClientIp(ip))}`;
  const emailHash = resendFingerprint('email', email.trim().toLowerCase());
  const emailKey = `email:${emailHash}`;
  const cooldownKey = `cooldown:${emailHash}`;

  const db = getDb();
  const result = await db.transaction(async (tx) => {
    const ipResult = await consumeQuota(tx, ipKey, ipLimit, ipWindow);
    if (!ipResult.allowed) return { allowed: false, retryAfterSeconds: ipResult.retry };

    // Lock the e-mail quota first: two different IPs cannot both reserve the same address.
    await tx.execute(sql`INSERT INTO auth_rate_limit (key, used, expires_at)
      VALUES (${emailKey}, 0, now() + ${emailWindow} * interval '1 second')
      ON CONFLICT (key) DO NOTHING`);
    const emailRows = await tx.execute(sql`SELECT used,
      CEIL(EXTRACT(EPOCH FROM (expires_at - now()))) AS retry
      FROM auth_rate_limit WHERE key = ${emailKey} FOR UPDATE`);
    const emailRow = emailRows[0] as unknown as { used: number; retry: string | number };
    const emailRetry = Number(emailRow.retry);
    const cooldownRows = await tx.execute(sql`SELECT
      CEIL(EXTRACT(EPOCH FROM (expires_at - now()))) AS retry
      FROM auth_rate_limit WHERE key = ${cooldownKey} AND expires_at > now()`);
    const cooldownRetry = Number(cooldownRows[0]?.retry ?? 0);
    const quotaRetry = emailRetry > 0 && Number(emailRow.used) >= emailLimit ? emailRetry : 0;
    const retry = Math.max(cooldownRetry, quotaRetry);
    if (retry > 0) return { allowed: false, retryAfterSeconds: retry };

    await consumeQuota(tx, emailKey, emailLimit, emailWindow);
    await tx.execute(sql`INSERT INTO auth_rate_limit (key, used, expires_at)
      VALUES (${cooldownKey}, 1, now() + ${cooldown} * interval '1 second')
      ON CONFLICT (key) DO UPDATE SET used = 1, expires_at = EXCLUDED.expires_at`);
    return { allowed: true, retryAfterSeconds: cooldown };
  });
  await deleteExpiredQuotas('resend-confirmation');
  return result;
}
