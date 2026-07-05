/**
 * Seleção do provedor de autenticação — permite a migração faseada e REVERSÍVEL
 * Supabase Auth → Better Auth por variável de ambiente, sem redeploy de código.
 *
 *   AUTH_PROVIDER=betterauth (default) → Better Auth (Postgres próprio)
 *   AUTH_PROVIDER=supabase             → fluxo legado (Supabase Auth) — ROLLBACK
 *
 * Cutover (jul/2026): o default virou `betterauth`. O modo supabase segue como
 * rede de segurança (basta setar AUTH_PROVIDER=supabase, sem redeploy) até o
 * PR2 remover o código legado. Pré-requisito em produção: rodar
 * `db/cutover/betterauth-enable.sql` (cria as tabelas Better Auth e remove a FK
 * enterprise.auth_user_id→auth.users, senão o signup betterauth viola a FK).
 *
 * Lido em tempo de chamada (não cacheado em módulo) para os testes poderem
 * alternar o modo via process.env.
 */
export function isBetterAuth(): boolean {
  return (process.env.AUTH_PROVIDER ?? 'betterauth').trim().toLowerCase() === 'betterauth';
}
