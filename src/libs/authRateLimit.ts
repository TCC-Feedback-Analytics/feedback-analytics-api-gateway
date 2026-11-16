/**
 * Limite das rotas públicas de autenticação, contado no banco (tabela
 * `auth_rate_limit`) para valer entre todas as instâncias da Vercel. As chaves
 * guardam só o HMAC do IP e do e-mail, nunca o valor.
 *
 * O limite do próprio Better Auth não cobre estas rotas: ele roda só no handler
 * HTTP de `/api/auth/*`, e o login, a nova senha e o cadastro chamam a API dele
 * por dentro do servidor.
 */
import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request } from 'express';
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';

export type RateLimitReservation = { allowed: boolean; retryAfterSeconds: number };

/** O banco do app ou uma transação dele. */
type SqlExecutor = { execute: ReturnType<typeof getDb>['execute'] };

export function positiveEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${name}`);
  return parsed;
}

export function normalizeClientIp(value: string): string {
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

export function authClientIp(req: Request): string {
  // Vercel overwrites this header at its trusted ingress. Never trust it locally.
  const raw = process.env.VERCEL === '1' ? req.get('x-forwarded-for') : req.socket.remoteAddress;
  return normalizeClientIp(raw ?? '');
}

export function authFingerprint(scope: string, kind: 'ip' | 'email', value: string): string {
  const secret = process.env.RESEND_RATE_LIMIT_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) throw new Error('Missing auth rate limit secret');
  return createHmac('sha256', secret).update(`${scope}:${kind}:${value}`).digest('hex');
}

/** Gasta uma vaga da chave. A contagem para em limit + 1, e a janela recomeça quando vence. */
export async function consumeQuota(db: SqlExecutor, key: string, limit: number, seconds: number) {
  const rows = await db.execute(sql`
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
}

/** Apaga até 100 chaves vencidas. Falhar aqui não bloqueia o pedido. */
export async function deleteExpiredQuotas(logTag: string): Promise<void> {
  try {
    await getDb().execute(sql`DELETE FROM auth_rate_limit WHERE key IN (
      SELECT key FROM auth_rate_limit WHERE expires_at <= now()
      ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
    )`);
  } catch {
    console.warn(`[${logTag}] limpeza dos limites indisponível`);
  }
}

export type AuthAttemptAction = 'login' | 'forgot-password' | 'register';

type Quota = { max: number; windowSeconds: number };

/**
 * O login conta só as tentativas que falham (quem acerta a senha devolve a vaga),
 * e o limite por IP é largo porque, em produção, o login passa pelo repasse da
 * Vercel na Web e vários usuários podem chegar com o mesmo IP. A nova senha e o
 * cadastro mandam e-mail a cada pedido, então contam todos.
 */
const DEFAULT_QUOTAS: Record<AuthAttemptAction, { ip: Quota; email: Quota }> = {
  login: { ip: { max: 100, windowSeconds: 900 }, email: { max: 10, windowSeconds: 900 } },
  'forgot-password': { ip: { max: 20, windowSeconds: 900 }, email: { max: 5, windowSeconds: 3600 } },
  register: { ip: { max: 20, windowSeconds: 900 }, email: { max: 5, windowSeconds: 3600 } },
};

/** Ex.: LOGIN_IP_MAX, FORGOT_PASSWORD_EMAIL_WINDOW_SECONDS. */
function readQuota(action: AuthAttemptAction, kind: 'ip' | 'email'): Quota {
  const prefix = `${action.toUpperCase().replace('-', '_')}_${kind.toUpperCase()}`;
  const fallback = DEFAULT_QUOTAS[action][kind];
  return {
    max: positiveEnv(`${prefix}_MAX`, fallback.max),
    windowSeconds: positiveEnv(`${prefix}_WINDOW_SECONDS`, fallback.windowSeconds),
  };
}

function attemptKeys(action: AuthAttemptAction, ip: string, email: string) {
  const ipHash = authFingerprint(action, 'ip', normalizeClientIp(ip));
  const emailHash = authFingerprint(action, 'email', email.trim().toLowerCase());
  return { ip: `${action}:ip:${ipHash}`, email: `${action}:email:${emailHash}` };
}

/** Gasta uma vaga do IP e uma do e-mail. O IP bloqueado não chega a gastar a do e-mail. */
export async function reserveAuthAttempt(
  action: AuthAttemptAction,
  ip: string,
  email: string,
): Promise<RateLimitReservation> {
  const keys = attemptKeys(action, ip, email);
  const ipQuota = readQuota(action, 'ip');
  const emailQuota = readQuota(action, 'email');
  const db = getDb();

  const ipResult = await consumeQuota(db, keys.ip, ipQuota.max, ipQuota.windowSeconds);
  const result = ipResult.allowed
    ? await consumeQuota(db, keys.email, emailQuota.max, emailQuota.windowSeconds)
    : ipResult;
  await deleteExpiredQuotas('auth-rate-limit');
  return { allowed: result.allowed, retryAfterSeconds: result.allowed ? 0 : result.retry };
}

/** Devolve a vaga gasta por reserveAuthAttempt (login que deu certo). */
export async function releaseAuthAttempt(action: AuthAttemptAction, ip: string, email: string): Promise<void> {
  const keys = attemptKeys(action, ip, email);
  await getDb().execute(sql`UPDATE auth_rate_limit SET used = GREATEST(used - 1, 0)
    WHERE (key = ${keys.ip} OR key = ${keys.email}) AND expires_at > now()`);
}
