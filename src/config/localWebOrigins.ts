/**
 * A Web rodando na máquina (dev e preview do Vite). Entra no CORS e nas origens
 * confiáveis do Better Auth só fora de produção: em produção, qualquer página
 * aberta em localhost no computador de alguém poderia chamar o Gateway com a
 * sessão dessa pessoa.
 */
export function localWebOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV === 'production') return [];
  return ['http://localhost:5173', 'http://localhost:4173'];
}
