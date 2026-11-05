/**
 * Resumo do erro para os logs: nome e código (o do Postgres, quando houver).
 * Não leva a mensagem: a do Drizzle traz a query e os parâmetros (comentário,
 * IP, e-mail do cliente), que não podem ir para os logs da Vercel.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'erro desconhecido';
  const code = readCode(error.cause) ?? readCode(error);
  return code ? `${error.name} code=${code}` : error.name;
}

function readCode(value: unknown): string | null {
  const code = (value as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : null;
}
