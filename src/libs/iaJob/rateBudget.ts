/**
 * Rate limiter (token bucket) durável para as chamadas ao LLM — o "controle de
 * ritmo" da etapa 03. Duas janelas alinhadas às cotas do provedor: por MINUTO
 * (RPM) e por DIA (a cota diária que hoje estoura). A reserva é ATÔMICA e
 * durável (tabela `ia_rate_budget`), então sobrevive a reinícios e é
 * consistente entre ticks/instâncias concorrentes.
 *
 * Escopo `global` hoje (chave de IA compartilhada). A etapa 04 (BYO-key) passa a
 * usar o `enterprise_id` como escopo, sem tocar no schema.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { readRpdLimit, readRpmLimit } from './config.js';

export type BudgetReservation = { ok: true } | { ok: false; reason: 'minute' | 'day' };

class BudgetExhausted extends Error {
  constructor(public readonly reason: 'minute' | 'day') {
    super(`ia budget exhausted: ${reason}`);
  }
}

/**
 * Reserva UMA "ficha" para uma chamada ao LLM, nas duas janelas. Tudo numa
 * transação: se a janela de DIA ou de MINUTO estourou, faz rollback (não vaza
 * ficha) e devolve `{ ok:false, reason }`. Limites 0/ausentes = sem limite.
 *
 * `scope` isola o balde: `'global'` (chave compartilhada) ou o `enterprise_id`
 * (BYO-key da etapa 04 — cada empresa passa a ter a própria cota).
 *
 * A reserva usa `INSERT ... ON CONFLICT DO UPDATE ... WHERE used < limite`: se a
 * cota já estourou, o UPDATE não afeta linha e o RETURNING volta vazio.
 */
export async function reserveIaBudget(scope: string = 'global'): Promise<BudgetReservation> {
  const rpm = readRpmLimit();
  const rpd = readRpdLimit();

  if (rpm <= 0 && rpd <= 0) return { ok: true };

  try {
    await getDb().transaction(async (tx) => {
      if (rpd > 0) {
        const day = (await tx.execute(sql`
          INSERT INTO ia_rate_budget (scope, window_kind, window_start, used)
          VALUES (${scope},'day', date_trunc('day', now()), 1)
          ON CONFLICT (scope, window_kind, window_start)
          DO UPDATE SET used = ia_rate_budget.used + 1 WHERE ia_rate_budget.used < ${rpd}
          RETURNING used
        `)) as unknown as unknown[];
        if (day.length === 0) throw new BudgetExhausted('day');
      }

      if (rpm > 0) {
        const minute = (await tx.execute(sql`
          INSERT INTO ia_rate_budget (scope, window_kind, window_start, used)
          VALUES (${scope},'minute', date_trunc('minute', now()), 1)
          ON CONFLICT (scope, window_kind, window_start)
          DO UPDATE SET used = ia_rate_budget.used + 1 WHERE ia_rate_budget.used < ${rpm}
          RETURNING used
        `)) as unknown as unknown[];
        if (minute.length === 0) throw new BudgetExhausted('minute');
      }
    });

    return { ok: true };
  } catch (error) {
    if (error instanceof BudgetExhausted) return { ok: false, reason: error.reason };
    throw error;
  }
}
