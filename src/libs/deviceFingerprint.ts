/**
 * Identificação do aparelho que envia o formulário público, base do limite de uma
 * resposta por aparelho, ponto de coleta e dia (RNE-004) e do bloqueio de aparelho.
 *
 * É um HMAC-SHA-256 do navegador e do IP com um segredo do servidor: quem vê o banco
 * não consegue recalcular o valor a partir de um navegador e um IP conhecidos.
 * Antes era um MD5 sem segredo, que continua calculado só para reconhecer os
 * aparelhos gravados naquele formato (ver migrateLegacyDevice no controller).
 */
import { createHash, createHmac } from 'node:crypto';

function fingerprintSecret(): string {
  const secret = process.env.DEVICE_FINGERPRINT_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) throw new Error('Missing device fingerprint secret');
  return secret;
}

export function deviceFingerprint(userAgent: string, clientIp: string): string {
  return createHmac('sha256', fingerprintSecret()).update(`device:${userAgent}|${clientIp}`).digest('hex');
}

/** Formato antigo (MD5 sem segredo), usado só para migrar os aparelhos já gravados. */
export function legacyDeviceFingerprint(userAgent: string, clientIp: string): string {
  return createHash('md5').update(`${userAgent}|${clientIp}`).digest('hex');
}
