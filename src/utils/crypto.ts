import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

/**
 * Cifra simétrica AES-256-GCM para segredos guardados no banco (etapa 04: a chave
 * OpenRouter por empresa). GCM é autenticado: a `authTag` detecta adulteração.
 * A chave-mestra vem de `IA_CONFIG_ENCRYPTION_KEY` (env, nunca no repo).
 */
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // recomendado para GCM

export type CipherParts = { ciphertext: string; iv: string; authTag: string };

/**
 * Deriva a chave de 32 bytes a partir de `IA_CONFIG_ENCRYPTION_KEY`: aceita um
 * base64 de exatamente 32 bytes (gere com `openssl rand -base64 32`) ou qualquer
 * string, derivando 32 bytes estáveis via SHA-256. Falha claro se não configurada.
 */
function getKey(): Buffer {
  const raw = String(process.env.IA_CONFIG_ENCRYPTION_KEY ?? '').trim();
  if (!raw) {
    throw new Error(
      'IA_CONFIG_ENCRYPTION_KEY não configurada — necessária para cifrar a chave de IA por empresa.',
    );
  }
  const asBase64 = Buffer.from(raw, 'base64');
  if (asBase64.length === 32) return asBase64;
  return createHash('sha256').update(raw, 'utf8').digest();
}

/** Cifra um texto; devolve ciphertext/iv/authTag em base64 (para colunas text). */
export function encryptSecret(plaintext: string): CipherParts {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

/** Decifra o que `encryptSecret` gerou. Lança se a authTag não bater (dado adulterado). */
export function decryptSecret(parts: CipherParts): string {
  const decipher = createDecipheriv(ALGO, getKey(), Buffer.from(parts.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(parts.authTag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(parts.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
