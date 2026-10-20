/**
 * Diagnósticos do escopo guardados (histórico por empresa, escopo e item).
 * Isolamento multi-tenant: SEMPRE via `scopedByEnterprise` (a role do Drizzle
 * ignora a RLS — ver tenantScope).
 */
import { desc, eq, isNull, type SQL } from 'drizzle-orm';
import type { ScopeDiagnosisResult } from '@feedback/lib-shared/interfaces/contracts/ia-analyze/scope-diagnosis.contract';
import { getDb } from '../db/client.js';
import { scopeDiagnosis } from '../../drizzle/schema.js';
import { scopedByEnterprise } from '../db/tenantScope.js';

export type ScopeDiagnosisKey = {
  enterpriseId: string;
  scopeType: string;
  catalogItemId: string | null;
};

export type ScopeDiagnosisRow = {
  id: string;
  scopeType: string;
  catalogItemId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  previousStart: string | null;
  previousEnd: string | null;
  feedbackCount: number;
  model: string | null;
  createdAt: string;
  result: ScopeDiagnosisResult;
};

const ROW_COLUMNS = {
  id: scopeDiagnosis.id,
  scopeType: scopeDiagnosis.scopeType,
  catalogItemId: scopeDiagnosis.catalogItemId,
  periodStart: scopeDiagnosis.periodStart,
  periodEnd: scopeDiagnosis.periodEnd,
  previousStart: scopeDiagnosis.previousStart,
  previousEnd: scopeDiagnosis.previousEnd,
  feedbackCount: scopeDiagnosis.feedbackCount,
  model: scopeDiagnosis.model,
  createdAt: scopeDiagnosis.createdAt,
  result: scopeDiagnosis.result,
};

function scopeWhere(key: ScopeDiagnosisKey, ...extra: SQL[]): SQL {
  return scopedByEnterprise(
    scopeDiagnosis.enterpriseId,
    key.enterpriseId,
    eq(scopeDiagnosis.scopeType, key.scopeType),
    key.catalogItemId === null ? isNull(scopeDiagnosis.catalogItemId) : eq(scopeDiagnosis.catalogItemId, key.catalogItemId),
    ...extra,
  );
}

/** Diagnóstico já gerado com exatamente os mesmos dados (mesmo hash), ou null. */
export async function findScopeDiagnosisByHash(key: ScopeDiagnosisKey, dataHash: string): Promise<string | null> {
  const rows = await getDb()
    .select({ id: scopeDiagnosis.id })
    .from(scopeDiagnosis)
    .where(scopeWhere(key, eq(scopeDiagnosis.dataHash, dataHash)))
    .orderBy(desc(scopeDiagnosis.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function insertScopeDiagnosis(key: ScopeDiagnosisKey & {
  periodStart: string | null;
  periodEnd: string | null;
  previousStart: string | null;
  previousEnd: string | null;
  feedbackCount: number;
  dataHash: string;
  model: string | null;
  result: ScopeDiagnosisResult;
}): Promise<string> {
  const [row] = await getDb()
    .insert(scopeDiagnosis)
    .values({
      enterpriseId: key.enterpriseId,
      scopeType: key.scopeType,
      catalogItemId: key.catalogItemId,
      periodStart: key.periodStart,
      periodEnd: key.periodEnd,
      previousStart: key.previousStart,
      previousEnd: key.previousEnd,
      feedbackCount: key.feedbackCount,
      dataHash: key.dataHash,
      model: key.model,
      result: key.result,
    })
    .returning({ id: scopeDiagnosis.id });
  return row.id;
}

/** O mais recente do escopo, de qualquer período. */
export async function fetchLatestScopeDiagnosis(key: ScopeDiagnosisKey): Promise<ScopeDiagnosisRow | null> {
  const rows = await getDb()
    .select(ROW_COLUMNS)
    .from(scopeDiagnosis)
    .where(scopeWhere(key))
    .orderBy(desc(scopeDiagnosis.createdAt))
    .limit(1);
  return (rows[0] as ScopeDiagnosisRow | undefined) ?? null;
}

/** Um diagnóstico pelo id, só se for da empresa. */
export async function fetchScopeDiagnosisById(enterpriseId: string, id: string): Promise<ScopeDiagnosisRow | null> {
  const rows = await getDb()
    .select(ROW_COLUMNS)
    .from(scopeDiagnosis)
    .where(scopedByEnterprise(scopeDiagnosis.enterpriseId, enterpriseId, eq(scopeDiagnosis.id, id)))
    .limit(1);
  return (rows[0] as ScopeDiagnosisRow | undefined) ?? null;
}

/** Histórico do escopo, do mais novo ao mais antigo. */
export async function listScopeDiagnoses(key: ScopeDiagnosisKey, limit = 20): Promise<ScopeDiagnosisRow[]> {
  const rows = await getDb()
    .select(ROW_COLUMNS)
    .from(scopeDiagnosis)
    .where(scopeWhere(key))
    .orderBy(desc(scopeDiagnosis.createdAt))
    .limit(limit);
  return rows as ScopeDiagnosisRow[];
}
