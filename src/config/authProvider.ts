/**
 * Seleção do provedor de autenticação — permite a migração faseada e REVERSÍVEL
 * Supabase Auth → Better Auth por variável de ambiente, sem redeploy de código.
 *
 *   AUTH_PROVIDER=supabase   (default) → fluxo atual (Supabase Auth)
 *   AUTH_PROVIDER=betterauth           → Better Auth (Postgres próprio)
 *
 * Lido em tempo de chamada (não cacheado em módulo) para os testes poderem
 * alternar o modo via process.env.
 */
export function isBetterAuth(): boolean {
  return (process.env.AUTH_PROVIDER ?? 'supabase').trim().toLowerCase() === 'betterauth';
}
