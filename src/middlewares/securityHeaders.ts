// Cabeçalhos de segurança em todas as respostas do gateway. A API só devolve JSON e
// redirecionamentos, então a política é a mais fechada: nada é carregado, nada pode
// embutir a resposta num iframe e o navegador não tenta adivinhar o tipo do conteúdo.

import type { NextFunction, Request, Response } from 'express';

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  next();
}
