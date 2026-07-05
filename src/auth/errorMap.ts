/**
 * Tradução dos erros do Better Auth (`APIError`) para os MESMOS códigos tipados
 * que o front consome hoje — preservando o contrato dos mappers Supabase
 * (login/register/forgot/resend/reset). Reproduz o particionamento por mensagem
 * e mantém o RNE-014 (conta não verificada → 401 invalid_credentials, sem vazar
 * que o e-mail existe/não foi confirmado).
 *
 * Robusto a variações de forma do erro: inspeciona status/statusCode, body.code e
 * a mensagem (lowercased), então continua correto mesmo se o Better Auth ajustar
 * os identificadores entre versões.
 */
import {
  API_ERROR_INVALID_CREDENTIALS,
  API_ERROR_INVALID_PAYLOAD,
  API_ERROR_SIGNUP_FAILED,
  API_ERROR_EMAIL_TAKEN,
  API_ERROR_RESET_PASSWORD_FAILED,
  API_ERROR_RESET_PASSWORD_WEAK,
  API_ERROR_RESET_PASSWORD_INVALID_TOKEN,
} from '../config/errors.js';

// Literais que hoje são inline nos controllers (não constam em config/errors.ts).
export const API_ERROR_RATE_LIMITED = 'rate_limited' as const;
export const API_ERROR_SERVICE_UNAVAILABLE = 'service_unavailable' as const;
export const API_ERROR_LOGIN_FAILED = 'login_failed' as const;
export const API_ERROR_RESEND_FAILED = 'resend_failed' as const;
export const API_ERROR_UNAUTHORIZED = 'unauthorized' as const;

export interface MappedError {
  http: number;
  code: string;
  message: string;
}

const STATUS_NAME_TO_CODE: Record<string, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

interface NormalizedError {
  status: number;
  code: string;
  message: string;
}

function normalize(err: unknown): NormalizedError {
  const e = (err ?? {}) as Record<string, unknown>;
  const body = (e.body ?? {}) as Record<string, unknown>;

  const rawStatus = e.status ?? e.statusCode;
  let status = 0;
  if (typeof rawStatus === 'number') {
    status = rawStatus;
  } else if (typeof rawStatus === 'string') {
    status = STATUS_NAME_TO_CODE[rawStatus] ?? 0;
  }

  const code = String(body.code ?? e.code ?? '').toUpperCase();
  const message = String(body.message ?? e.message ?? '').trim();

  return { status, code, message };
}

function includesAny(haystack: string, needles: string[]): boolean {
  const h = haystack.toLowerCase();
  return needles.some((n) => h.includes(n));
}

/** POST /api/public/auth/login */
export function mapLoginError(err: unknown): MappedError {
  const { status, code, message } = normalize(err);
  const msg = message.toLowerCase();

  // RNE-014: e-mail não confirmado responde IGUAL a credencial inválida
  // (a mensagem NÃO pode conter 'confirm'/'verificad').
  if (code === 'EMAIL_NOT_VERIFIED' || includesAny(msg, ['not verified', 'not confirmed', 'email_not_verified'])) {
    return { http: 401, code: API_ERROR_INVALID_CREDENTIALS, message: 'E-mail ou senha inválidos.' };
  }

  if (
    code === 'INVALID_EMAIL_OR_PASSWORD' ||
    status === 401 ||
    includesAny(msg, ['invalid email or password', 'invalid credentials', 'invalid login'])
  ) {
    return { http: 401, code: API_ERROR_INVALID_CREDENTIALS, message: 'E-mail ou senha inválidos.' };
  }

  if (status === 429 || includesAny(msg, ['too many requests', 'rate limit'])) {
    return { http: 429, code: API_ERROR_RATE_LIMITED, message: 'Muitas tentativas. Aguarde e tente novamente.' };
  }

  if (includesAny(msg, ['invalid email', 'email address is invalid'])) {
    return { http: 400, code: API_ERROR_INVALID_PAYLOAD, message: 'E-mail inválido. Verifique o formato.' };
  }

  if (status >= 500 || includesAny(msg, ['unavailable', 'internal server error', 'unexpected'])) {
    return { http: 503, code: API_ERROR_SERVICE_UNAVAILABLE, message: 'Serviço temporariamente indisponível.' };
  }

  return { http: 401, code: API_ERROR_LOGIN_FAILED, message: 'Não foi possível realizar o login no momento.' };
}

/** POST /api/public/auth/register (erros do signUpEmail; document/phone são tratados no controller) */
export function mapRegisterError(err: unknown): MappedError {
  const { status, code, message } = normalize(err);
  const msg = message.toLowerCase();

  if (code === 'USER_ALREADY_EXISTS' || includesAny(msg, ['user already registered', 'user already exists', 'already exists'])) {
    // O controller converte em 200 { ok:true, message:'confirmation_required' } (anti-enumeração).
    return { http: 409, code: API_ERROR_EMAIL_TAKEN, message: 'E-mail já cadastrado.' };
  }

  if (code === 'PASSWORD_TOO_SHORT' || includesAny(msg, ['password too short', 'password should be at least', 'weak password', 'password is too weak'])) {
    return { http: 400, code: API_ERROR_SIGNUP_FAILED, message: 'Senha fraca. Use no mínimo 8 caracteres.' };
  }

  if (status === 429 || includesAny(msg, ['rate limit', 'too many requests'])) {
    return { http: 429, code: API_ERROR_SIGNUP_FAILED, message: 'Muitas tentativas em pouco tempo. Aguarde e tente novamente.' };
  }

  if (includesAny(msg, ['invalid email', 'email address is invalid'])) {
    return { http: 400, code: API_ERROR_SIGNUP_FAILED, message: 'E-mail inválido. Verifique o formato e tente novamente.' };
  }

  if (status >= 500 || includesAny(msg, ['unavailable', 'internal server error'])) {
    return { http: 503, code: API_ERROR_SIGNUP_FAILED, message: 'Novos cadastros estão temporariamente indisponíveis.' };
  }

  return { http: 400, code: API_ERROR_SIGNUP_FAILED, message: message || 'Não foi possível criar sua conta.' };
}

/** POST /api/public/auth/forgot-password (sempre 200 no controller; este map cobre falhas reais raras) */
export function mapForgotPasswordError(err: unknown): MappedError {
  const { status, message } = normalize(err);
  const msg = message.toLowerCase();

  if (status === 429 || includesAny(msg, ['rate limit', 'too many requests'])) {
    return { http: 429, code: API_ERROR_RATE_LIMITED, message: 'Muitas tentativas. Aguarde e tente novamente.' };
  }
  if (status >= 500 || includesAny(msg, ['unavailable', 'internal server error'])) {
    return { http: 503, code: API_ERROR_SERVICE_UNAVAILABLE, message: 'Serviço temporariamente indisponível.' };
  }
  return { http: 400, code: API_ERROR_RESET_PASSWORD_FAILED, message: 'Não foi possível processar a solicitação.' };
}

/** POST /api/public/auth/resend-confirmation */
export function mapResendError(err: unknown): MappedError {
  const { status, message } = normalize(err);
  const msg = message.toLowerCase();

  if (status === 429 || includesAny(msg, ['rate limit', 'too many requests'])) {
    return { http: 429, code: API_ERROR_RATE_LIMITED, message: 'Muitas tentativas de reenvio. Aguarde e tente novamente.' };
  }
  if (includesAny(msg, ['invalid email', 'email address is invalid'])) {
    return { http: 400, code: API_ERROR_INVALID_PAYLOAD, message: 'E-mail inválido.' };
  }
  if (status >= 500 || includesAny(msg, ['unavailable', 'signup is disabled', 'signups not allowed'])) {
    return { http: 503, code: API_ERROR_SERVICE_UNAVAILABLE, message: 'Serviço de reenvio temporariamente indisponível.' };
  }
  return { http: 400, code: API_ERROR_RESEND_FAILED, message: 'Não foi possível reenviar o e-mail.' };
}

/** PATCH /api/protected/user/password (reset de senha) */
export function mapResetPasswordError(err: unknown): MappedError {
  const { status, code, message } = normalize(err);
  const msg = message.toLowerCase();

  if (code === 'INVALID_TOKEN' || status === 401 || includesAny(msg, ['invalid token', 'expired', 'invalid_token'])) {
    return {
      http: 401,
      code: API_ERROR_RESET_PASSWORD_INVALID_TOKEN,
      message: 'O link de redefinição expirou ou é inválido. Solicite um novo.',
    };
  }
  if (code === 'PASSWORD_TOO_SHORT' || includesAny(msg, ['password too short', 'password should be at least', 'weak password'])) {
    return { http: 400, code: API_ERROR_RESET_PASSWORD_WEAK, message: 'Senha fraca. Use uma senha mais forte.' };
  }
  if (status >= 500 || includesAny(msg, ['unavailable', 'internal server error'])) {
    return { http: 503, code: API_ERROR_SERVICE_UNAVAILABLE, message: 'Serviço temporariamente indisponível.' };
  }
  return { http: 400, code: API_ERROR_RESET_PASSWORD_FAILED, message: 'Não foi possível redefinir a senha.' };
}
