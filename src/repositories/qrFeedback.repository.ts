import { and, eq, gte } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {
  customer,
  feedback,
  feedbackQuestionAnswers,
  feedbackSubquestionAnswers,
  trackedDevices,
} from '../../drizzle/schema.js';

/**
 * Erro tipado das escritas do submit anônimo. Serve só para o controller mapear
 * ao código HTTP certo (o rollback é automático via `db.transaction`).
 */
export class QrFeedbackWriteError extends Error {
  constructor(public readonly failure: 'device_creation' | 'feedback_insert') {
    super(failure);
    this.name = 'QrFeedbackWriteError';
  }
}

export interface TrackedDeviceRow {
  id: string;
  lastFeedbackAt: string | null;
  isBlocked: boolean | null;
  feedbackCount: number | null;
  customerId: string | null;
}

/**
 * Dispositivo rastreado da empresa por fingerprint. SEMPRE tenant-scoped por
 * `enterprise_id` (a role do Drizzle ignora a RLS — invariante nº1).
 */
export async function findTrackedDevice(params: {
  enterpriseId: string;
  deviceFingerprint: string;
}): Promise<TrackedDeviceRow | null> {
  const rows = await getDb()
    .select({
      id: trackedDevices.id,
      lastFeedbackAt: trackedDevices.lastFeedbackAt,
      isBlocked: trackedDevices.isBlocked,
      feedbackCount: trackedDevices.feedbackCount,
      customerId: trackedDevices.customerId,
    })
    .from(trackedDevices)
    .where(
      and(
        eq(trackedDevices.enterpriseId, params.enterpriseId),
        eq(trackedDevices.deviceFingerprint, params.deviceFingerprint),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Já existe feedback deste dispositivo, neste ponto de coleta, a partir de
 * `sinceIso` (início do dia)? Base do 409 de deduplicação diária.
 */
export async function hasFeedbackSince(params: {
  enterpriseId: string;
  trackedDeviceId: string;
  collectionPointId: string;
  sinceIso: string;
}): Promise<boolean> {
  const rows = await getDb()
    .select({ id: feedback.id })
    .from(feedback)
    .where(
      and(
        eq(feedback.enterpriseId, params.enterpriseId),
        eq(feedback.trackedDeviceId, params.trackedDeviceId),
        eq(feedback.collectionPointId, params.collectionPointId),
        gte(feedback.createdAt, params.sinceIso),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

/** Cliente existente por e-mail dentro da empresa. */
export async function findCustomerByEmail(params: {
  enterpriseId: string;
  email: string;
}): Promise<{ id: string } | null> {
  const rows = await getDb()
    .select({ id: customer.id })
    .from(customer)
    .where(and(eq(customer.enterpriseId, params.enterpriseId), eq(customer.email, params.email)))
    .limit(1);

  return rows[0] ?? null;
}

/** Cria um cliente e devolve o id. O chamador trata falha como não-fatal. */
export async function insertCustomer(params: {
  enterpriseId: string;
  name: string | null;
  email: string | null;
  gender: string | null;
}): Promise<{ id: string } | null> {
  const rows = await getDb()
    .insert(customer)
    .values({
      enterpriseId: params.enterpriseId,
      name: params.name,
      email: params.email,
      gender: params.gender,
    })
    .returning({ id: customer.id });

  return rows[0] ?? null;
}

export interface NewQuestionAnswer {
  questionId: string;
  questionTextSnapshot: string;
  answerValue: string;
  answerScore: number;
}

export interface NewSubquestionAnswer {
  subquestionId: string;
  subquestionTextSnapshot: string;
  answerValue: string;
  answerScore: number;
}

/**
 * Escrita atômica do feedback anônimo: resolve o dispositivo (insert do novo ou
 * update do customer_id do existente), insere o feedback e todas as respostas
 * numa ÚNICA transação. Qualquer falha faz rollback automático — substitui os
 * dois `feedback.delete` manuais do fluxo Supabase.
 *
 * NÃO inclui a atualização best-effort dos contadores do dispositivo: essa é
 * não-fatal (o Supabase retornava 200 mesmo se falhasse) e roda fora da
 * transação, via `updateTrackedDeviceCounters`.
 */
export async function persistQrFeedback(params: {
  enterpriseId: string;
  collectionPointId: string;
  feedbackId: string;
  message: string;
  rating: number;
  trackedDevice: TrackedDeviceRow | null;
  customerId: string | null;
  deviceFingerprint: string;
  userAgent: string;
  clientIP: string;
  answerRows: NewQuestionAnswer[];
  subanswerRows: NewSubquestionAnswer[];
}): Promise<{ trackedDeviceId: string; priorFeedbackCount: number }> {
  const nowIso = new Date().toISOString();

  return getDb().transaction(async (tx) => {
    let trackedDeviceId: string;
    let priorFeedbackCount: number;

    if (!params.trackedDevice) {
      let newDevice: { id: string } | undefined;
      try {
        const rows = await tx
          .insert(trackedDevices)
          .values({
            enterpriseId: params.enterpriseId,
            customerId: params.customerId,
            deviceFingerprint: params.deviceFingerprint,
            userAgent: params.userAgent,
            ipAddress: params.clientIP,
            lastFeedbackAt: nowIso,
            feedbackCount: 0,
            isBlocked: false,
          })
          .returning({ id: trackedDevices.id });
        newDevice = rows[0];
      } catch {
        throw new QrFeedbackWriteError('device_creation');
      }
      if (!newDevice) {
        throw new QrFeedbackWriteError('device_creation');
      }
      trackedDeviceId = newDevice.id;
      priorFeedbackCount = 0;
    } else {
      // Dispositivo já existe: NÃO tocamos no customer_id aqui. Vincular o
      // cliente era NÃO-FATAL no fluxo original (falha era engolida), então
      // fazê-lo dentro desta transação transformaria uma falha cosmética em
      // rollback do feedback. O vínculo roda fora da tx (linkTrackedDeviceCustomer).
      trackedDeviceId = params.trackedDevice.id;
      priorFeedbackCount = params.trackedDevice.feedbackCount ?? 0;
    }

    try {
      await tx.insert(feedback).values({
        id: params.feedbackId,
        enterpriseId: params.enterpriseId,
        collectionPointId: params.collectionPointId,
        trackedDeviceId,
        message: params.message,
        rating: params.rating,
      });

      if (params.answerRows.length > 0) {
        await tx.insert(feedbackQuestionAnswers).values(
          params.answerRows.map((row) => ({
            feedbackId: params.feedbackId,
            questionId: row.questionId,
            questionTextSnapshot: row.questionTextSnapshot,
            answerValue: row.answerValue,
            answerScore: row.answerScore,
          })),
        );
      }

      if (params.subanswerRows.length > 0) {
        await tx.insert(feedbackSubquestionAnswers).values(
          params.subanswerRows.map((row) => ({
            feedbackId: params.feedbackId,
            subquestionId: row.subquestionId,
            subquestionTextSnapshot: row.subquestionTextSnapshot,
            answerValue: row.answerValue,
            answerScore: row.answerScore,
          })),
        );
      }
    } catch (err) {
      if (err instanceof QrFeedbackWriteError) throw err;
      throw new QrFeedbackWriteError('feedback_insert');
    }

    return { trackedDeviceId, priorFeedbackCount };
  });
}

/**
 * Vincula (best-effort) um cliente a um dispositivo JÁ existente. Espelha a
 * semântica NÃO-FATAL do fluxo original: uma falha aqui não pode invalidar o
 * feedback já persistido, por isso roda FORA da transação e o chamador engole
 * o erro. (No dispositivo NOVO o customer_id já é gravado no insert, dentro da tx.)
 */
export async function linkTrackedDeviceCustomer(params: {
  id: string;
  customerId: string;
}): Promise<void> {
  await getDb()
    .update(trackedDevices)
    .set({ customerId: params.customerId })
    .where(eq(trackedDevices.id, params.id));
}

/**
 * Atualização best-effort dos contadores do dispositivo após o feedback. Falha
 * aqui NÃO invalida o feedback já persistido — o chamador engole o erro.
 */
export async function updateTrackedDeviceCounters(params: {
  id: string;
  feedbackCount: number;
  userAgent: string;
  clientIP: string;
}): Promise<void> {
  await getDb()
    .update(trackedDevices)
    .set({
      lastFeedbackAt: new Date().toISOString(),
      feedbackCount: params.feedbackCount,
      userAgent: params.userAgent,
      ipAddress: params.clientIP,
    })
    .where(eq(trackedDevices.id, params.id));
}
