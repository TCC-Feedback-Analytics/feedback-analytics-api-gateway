import { and, eq, gte, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { collectionPoints, feedback } from '../../drizzle/schema.js';
import type { MetricsPeriod } from '../libs/period.js';

/** Feedback de cliente, fora os do "Testar o formulário". `channel` nulo (antes da marca de canal) conta. */
export function notTestFeedback(): SQL {
  return sql`${feedback.channel} IS DISTINCT FROM 'TEST'`;
}

/**
 * Garante que nenhuma query tenant-scoped seja construída sem um enterprise_id.
 *
 * Como o Drizzle acessa o banco com uma role que IGNORA a RLS, esquecer o filtro
 * de empresa vazaria dados entre tenants. Aqui falhamos rápido e alto — é a
 * primeira linha de defesa do isolamento multi-tenant na aplicação.
 */
export function assertEnterpriseId(enterpriseId: string): void {
  if (!enterpriseId || typeof enterpriseId !== 'string') {
    throw new Error('Query tenant-scoped exige um enterprise_id não vazio.');
  }
}

/**
 * Condição WHERE para `feedback` SEMPRE filtrada por `enterprise_id`. Opcional:
 * restringe a um conjunto de `collection_point` ids (o escopo selecionado no
 * painel). É o "helper único" por onde passam as leituras de feedback via
 * Drizzle, garantindo o isolamento por empresa.
 *
 * Convenção de `collectionPointIds`:
 * - `null`  => toda a empresa (sem recorte de escopo);
 * - array NÃO vazio => recorta por esses pontos de coleta;
 * - array VAZIO => "nenhum resultado" (escopo sem pontos) e DEVE ser tratado
 *   pelo chamador antes de chamar este helper (que só aceita `null` ou não vazio).
 *
 * `period` (etapa 02) recorta por `created_at`: início incluído, fim excluído.
 * Sem período, vale o histórico inteiro. O índice `(enterprise_id, created_at)`
 * sustenta o recorte.
 *
 * Os feedbacks do "Testar o formulário" (canal `TEST`) ficam de fora: são do
 * dono, não de clientes, e não entram em métrica, mínimo nem análise da IA. Só
 * a lista de feedbacks os mostra (`includeTests`), marcados como teste.
 */
export function scopedFeedbackWhere(
  enterpriseId: string,
  collectionPointIds?: string[] | null,
  period?: MetricsPeriod | null,
  { includeTests = false }: { includeTests?: boolean } = {},
): SQL {
  assertEnterpriseId(enterpriseId);

  const conds: SQL[] = [eq(feedback.enterpriseId, enterpriseId)];

  if (!includeTests) conds.push(notTestFeedback());

  if (collectionPointIds && collectionPointIds.length > 0) {
    conds.push(inArray(feedback.collectionPointId, collectionPointIds));
  }
  if (period?.start) conds.push(gte(feedback.createdAt, period.start));
  if (period?.end) conds.push(lt(feedback.createdAt, period.end));

  return conds.length === 1 ? conds[0] : (and(...conds) as SQL);
}

/**
 * WHERE para `collection_points` SEMPRE filtrado por `enterprise_id`, cobrindo os
 * padrões repetidos do fluxo QR (tipo/status/ponto específico/escopo COMPANY ou
 * por item de catálogo). Como a role do Drizzle IGNORA a RLS, o `eq(enterprise_id)`
 * é a ÚNICA barreira cross-tenant — por isso é sempre incluído.
 *
 * Convenção de `catalogItemId`:
 * - `undefined` => não filtra por item;
 * - `null`      => `catalog_item_id IS NULL` (ponto "geral"/COMPANY);
 * - string      => aquele item.
 */
export function scopedCollectionPointWhere(
  enterpriseId: string,
  opts?: {
    id?: string;
    type?: string;
    status?: string;
    catalogItemId?: string | null;
    catalogItemIds?: string[];
  },
): SQL {
  assertEnterpriseId(enterpriseId);

  const conds: SQL[] = [eq(collectionPoints.enterpriseId, enterpriseId)];
  if (opts?.id) conds.push(eq(collectionPoints.id, opts.id));
  if (opts?.type) conds.push(eq(collectionPoints.type, opts.type));
  if (opts?.status) conds.push(eq(collectionPoints.status, opts.status));
  if (opts?.catalogItemId === null) {
    conds.push(isNull(collectionPoints.catalogItemId));
  } else if (opts?.catalogItemId) {
    conds.push(eq(collectionPoints.catalogItemId, opts.catalogItemId));
  }
  if (opts?.catalogItemIds && opts.catalogItemIds.length > 0) {
    conds.push(inArray(collectionPoints.catalogItemId, opts.catalogItemIds));
  }

  return (conds.length === 1 ? conds[0] : and(...conds)) as SQL;
}

/**
 * Helper fino para as demais tabelas que têm coluna `enterprise_id`
 * (catalog_items, questions_of_feedbacks, collecting_data_enterprise,
 * feedback_insights_report, customer, tracked_devices). Recebe a COLUNA
 * `enterprise_id` EXPLICITAMENTE — o TypeScript garante em compile-time que a
 * tabela tem a coluna, e a explicitude evita esquecer o escopo (sem reflection).
 *
 * Tabelas SEM `enterprise_id` (feedback_question_answers,
 * feedback_subquestion_answers, feedback_question_subquestions) NÃO usam este
 * helper: o isolamento delas é TRANSITIVO — os `feedback_id`/`question_id`
 * passados a montante DEVEM sempre vir de uma query já tenant-scoped.
 */
export function scopedByEnterprise(
  enterpriseIdColumn: PgColumn,
  enterpriseId: string,
  ...extra: Array<SQL | undefined>
): SQL {
  assertEnterpriseId(enterpriseId);
  const conds: SQL[] = [eq(enterpriseIdColumn, enterpriseId)];
  for (const e of extra) {
    if (e) conds.push(e);
  }
  return (conds.length === 1 ? conds[0] : and(...conds)) as SQL;
}
