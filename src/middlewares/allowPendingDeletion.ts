import type { NextFunction, Request, Response } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    // Marcado pela rota: a conta com exclusão agendada também passa no requireAuth.
    allowPendingDeletion?: boolean;
  }
}

/**
 * Vai antes do `requireAuth` nas poucas rotas que a conta parada ainda usa: ler o
 * próprio usuário (para a Web mostrar a data) e desistir da exclusão.
 */
export function allowPendingDeletion(req: Request, _res: Response, next: NextFunction) {
  req.allowPendingDeletion = true;
  next();
}
