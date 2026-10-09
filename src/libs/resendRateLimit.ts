import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request } from 'express';
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';

export type ResendReservation = { allowed: boolean; retryAfterSeconds: number };

function positiveEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${name}`);
  return parsed;
}

export function resendCooldownSeconds(): number {
  return positiveEnv('RESEND_EMAIL_COOLDOWN_SECONDS', 60);
}

export function normalizeResendIp(value: string): string {
  const ip = value.trim();
  if (!isIP(ip)) throw new Error('Missing or invalid client IP');
  if (ip.toLowerCase().startsWith('::ffff:') && isIP(ip.slice(7)) === 4) return ip.slice(7);
  if (isIP(ip) === 4) return ip;
  // URL serializes equivalent IPv6 representations identically.
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1]!, 16);
  const low = parseInt(mapped[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export function resendClientIp(req: Request): string {
  // Vercel overwrites this header at its trusted ingress. Never trust it locally.
  const raw = process.env.VERCEL === '1' ? req.get('x-forwarded-for') : req.socket.remoteAddress;
  return normalizeResendIp(raw ?? '');
}

export function resendFingerprint(kind: 'ip' | 'email', value: string): string {
  const secret = process.env.RESEND_RATE_LIMIT_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) throw new Error('Missing resend rate limit secret');
  return createHmac('sha256', secret).update(`resend-confirmation:${kind}:${value}`).digest('hex');
}

/** IP attempts are counted even when the e-mail is cooling down. All instances share row locks. */
export async function reserveResend(ip: string, email: string): Promise<ResendReservation> {
  const cooldown = resendCooldownSeconds();
  const ipLimit = positiveEnv('RESEND_IP_MAX', 20);
  const ipWindow = positiveEnv('RESEND_IP_WINDOW_SECONDS', 900);
  const emailLimit = positiveEnv('RESEND_EMAIL_MAX', 5);
  const emailWindow = positiveEnv('RESEND_EMAIL_WINDOW_SECONDS', 3600);
  const ipKey = `ip:${resendFingerprint('ip', normalizeResendIp(ip))}`;
  const emailHash = resendFingerprint('email', email.trim().toLowerCase());
  const emailKey = `email:${emailHash}`;
  const cooldownKey = `cooldown:${emailHash}`;

  const db = getDb();
  const result = await db.transaction(async (tx) => {
    const consume = async (key: string, limit: number, seconds: number) => {
      const rows = await tx.execute(sql`
        INSERT INTO auth_rate_limit (key, used, expires_at)
        VALUES (${key}, 1, now() + ${seconds} * interval '1 second')
        ON CONFLICT (key) DO UPDATE SET
          used = CASE WHEN auth_rate_limit.expires_at <= now() THEN 1
            ELSE LEAST(auth_rate_limit.used + 1, ${limit + 1}) END,
          expires_at = CASE WHEN auth_rate_limit.expires_at <= now()
            THEN now() + ${seconds} * interval '1 second' ELSE auth_rate_limit.expires_at END
        RETURNING used, CEIL(EXTRACT(EPOCH FROM (expires_at - now()))) AS retry
      `);
      const row = rows[0] as unknown as { used: number; retry: string | number };
      return { allowed: Number(row.used) <= limit, retry: Math.max(1, Number(row.retry)) };
    };

    const ipResult = await consume(ipKey, ipLimit, ipWindow);
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

    await consume(emailKey, emailLimit, emailWindow);
    await tx.execute(sql`INSERT INTO auth_rate_limit (key, used, expires_at)
      VALUES (${cooldownKey}, 1, now() + ${cooldown} * interval '1 second')
      ON CONFLICT (key) DO UPDATE SET used = 1, expires_at = EXCLUDED.expires_at`);
    return { allowed: true, retryAfterSeconds: cooldown };
  });
  try {
    await db.execute(sql`DELETE FROM auth_rate_limit WHERE key IN (
      SELECT key FROM auth_rate_limit WHERE expires_at <= now()
      ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
    )`);
  } catch {
    console.warn('[resend-confirmation] limpeza dos limites indisponível');
  }
  return result;
}
