/**
 * Cliente Drizzle (postgres-js) — único caminho de acesso a dados do gateway
 * (autenticado/interno E público, após o cutover para Better Auth). Lazy: a
 * conexão só é criada no primeiro uso; o módulo importa sem exigir `DATABASE_URL`
 * no boot (health check e testes sobem — o primeiro uso real sem a var lança erro
 * claro em `getDb()`).
 *
 * IMPORTANTE (segurança): o app entra como `feedback_app`. A RLS está ligada, mas a
 * policy `feedback_app_all` (migration 0013) libera todas as linhas para esse papel:
 * ela barra os outros papéis, não separa empresas. Portanto, TODA query por aqui
 * DEVE filtrar explicitamente por `enterprise_id` (use os helpers tenant-scoped).
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
// Schema canônico = saída introspectada do banco real (`npm run db:pull`).
import * as schema from '../../drizzle/schema.js';

let dbInstance: PostgresJsDatabase<typeof schema> | null = null;
let sqlClient: ReturnType<typeof postgres> | null = null;

/**
 * Opções do postgres-js para o pooler do Supabase (Supavisor, porta 6543, modo transação).
 *
 * - `prepare: false`: o modo transação não suporta prepared statements.
 * - `max` baixo: o gateway serverless não deve abrir muitas conexões (o teto do
 *   Supabase free é baixo).
 * - `max_pipeline: 1`: com as conexões ocupadas, o postgres-js v4 manda as
 *   consultas seguintes na mesma conexão antes da resposta da anterior. O
 *   Supavisor antes da 2.10 recebe essas consultas e nunca responde, e as
 *   conexões presas seguram todas as rotas da instância até ela cair. Foi o que
 *   travou o painel ao gerar o diagnóstico, que dispara várias consultas juntas.
 *   Uma consulta por conexão faz o excesso esperar na fila do próprio pool.
 * - `query_timeout` (segundos, fila + execução): se o pooler parar de responder
 *   por outro motivo, a consulta falha com `QUERY_TIMEOUT` e o pool reconecta,
 *   em vez de esperar o TCP perceber (minutos).
 */
export const SQL_CLIENT_OPTIONS = {
  prepare: false,
  max: 3,
  max_pipeline: 1,
  query_timeout: 15,
} as const;

/**
 * Retorna o cliente Drizzle (singleton). Lança erro claro se `DATABASE_URL` não
 * estiver configurada — assim a falha é diagnosticável, não um crash opaco.
 */
export function getDb(): PostgresJsDatabase<typeof schema> {
  if (dbInstance) {
    return dbInstance;
  }

  const connectionString = String(process.env.DATABASE_URL ?? '').trim();
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL não configurada — necessária para os caminhos servidos via Drizzle.',
    );
  }

  sqlClient = postgres(connectionString, SQL_CLIENT_OPTIONS);
  dbInstance = drizzle(sqlClient, { schema });
  return dbInstance;
}

/** Fecha a conexão (útil em testes/encerramento gracioso). */
export async function closeDb(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
    sqlClient = null;
    dbInstance = null;
  }
}
