import { describe, it, expect, afterAll, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb, closeDb } from '../../db/client.js';
import {
  QrFeedbackWriteError,
  findCustomerByEmail,
  findTrackedDevice,
  hasFeedbackSince,
  insertCustomer,
  linkTrackedDeviceCustomer,
  persistQrFeedback,
  updateTrackedDeviceCounters,
} from '../../repositories/qrFeedback.repository.js';

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000001';
const QR_GERAL_A = 'cccccccc-0000-0000-0000-0000000000aa';
const QR_GERAL_B = 'cccccccc-0000-0000-0000-0000000000bb';
const Q_A1 = 'dddddddd-0000-0000-0000-0000000000a1';
const Q_A2 = 'dddddddd-0000-0000-0000-0000000000a2';
const BAD_QUESTION = '99999999-9999-9999-9999-999999999999';

async function feedbackExists(id: string): Promise<boolean> {
  const rows = await getDb().execute(sql`SELECT 1 FROM public.feedback WHERE id = ${id} LIMIT 1`);
  return rows.length > 0;
}

async function answersCount(feedbackId: string): Promise<number> {
  const rows = await getDb().execute(
    sql`SELECT count(*)::int AS n FROM public.feedback_question_answers WHERE feedback_id = ${feedbackId}`,
  );
  return Number((rows[0] as { n: number }).n);
}

function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

// Limpa apenas o que os testes criam (marcados por prefixo 'itest-'). ATENÇÃO:
// no schema local `feedback` NÃO tem FK para tracked_devices, então deletar o
// device não cascateia o feedback — apago o feedback explicitamente (isso sim
// cascateia as respostas). Ordem: feedback → devices → customers.
afterEach(async () => {
  const db = getDb();
  await db.execute(sql`
    DELETE FROM public.feedback
    WHERE tracked_device_id IN (
      SELECT id FROM public.tracked_devices WHERE device_fingerprint LIKE 'itest-%'
    )
  `);
  await db.execute(sql`DELETE FROM public.tracked_devices WHERE device_fingerprint LIKE 'itest-%'`);
  await db.execute(sql`DELETE FROM public.customer WHERE email LIKE 'itest-%'`);
});

afterAll(async () => {
  await closeDb();
});

describe('[Integração] persistQrFeedback — escrita atômica do feedback anônimo', () => {
  it('cria dispositivo + feedback (0 respostas) numa transação; contadores best-effort', async () => {
    const fp = 'itest-fp-happy0';
    const feedbackId = crypto.randomUUID();

    const result = await persistQrFeedback({
      enterpriseId: A,
      collectionPointId: QR_GERAL_A,
      feedbackId,
      message: 'itest sem perguntas',
      rating: 5,
      trackedDevice: null,
      customerId: null,
      deviceFingerprint: fp,
      userAgent: 'itest-ua',
      clientIP: '127.0.0.1',
      answerRows: [],
      subanswerRows: [],
    });

    expect(result.priorFeedbackCount).toBe(0);
    expect(result.trackedDeviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await feedbackExists(feedbackId)).toBe(true);

    const device = await findTrackedDevice({ enterpriseId: A, deviceFingerprint: fp });
    expect(device?.id).toBe(result.trackedDeviceId);
    expect(device?.feedbackCount).toBe(0);

    await updateTrackedDeviceCounters({
      id: result.trackedDeviceId,
      feedbackCount: 1,
      userAgent: 'itest-ua2',
      clientIP: '127.0.0.1',
    });
    const bumped = await findTrackedDevice({ enterpriseId: A, deviceFingerprint: fp });
    expect(bumped?.feedbackCount).toBe(1);
  });

  it('insere feedback + respostas de perguntas na mesma transação', async () => {
    const fp = 'itest-fp-answers';
    const feedbackId = crypto.randomUUID();

    await persistQrFeedback({
      enterpriseId: A,
      collectionPointId: QR_GERAL_A,
      feedbackId,
      message: 'itest com respostas',
      rating: 4,
      trackedDevice: null,
      customerId: null,
      deviceFingerprint: fp,
      userAgent: 'itest-ua',
      clientIP: '127.0.0.1',
      answerRows: [
        { questionId: Q_A1, questionTextSnapshot: 'snap 1', answerValue: 'OTIMA', answerScore: 5 },
        { questionId: Q_A2, questionTextSnapshot: 'snap 2', answerValue: 'BOA', answerScore: 4 },
      ],
      subanswerRows: [],
    });

    expect(await feedbackExists(feedbackId)).toBe(true);
    expect(await answersCount(feedbackId)).toBe(2);
  });

  it('ROLLBACK: resposta com question_id inexistente desfaz feedback E device novo', async () => {
    const fp = 'itest-fp-rollback';
    const feedbackId = crypto.randomUUID();

    await expect(
      persistQrFeedback({
        enterpriseId: A,
        collectionPointId: QR_GERAL_A,
        feedbackId,
        message: 'itest rollback',
        rating: 3,
        trackedDevice: null,
        customerId: null,
        deviceFingerprint: fp,
        userAgent: 'itest-ua',
        clientIP: '127.0.0.1',
        answerRows: [
          { questionId: BAD_QUESTION, questionTextSnapshot: 'x', answerValue: 'OTIMA', answerScore: 5 },
        ],
        subanswerRows: [],
      }),
    ).rejects.toBeInstanceOf(QrFeedbackWriteError);

    // Atomicidade: nem o feedback nem o dispositivo recém-criado sobrevivem.
    expect(await feedbackExists(feedbackId)).toBe(false);
    expect(await findTrackedDevice({ enterpriseId: A, deviceFingerprint: fp })).toBeNull();
  });

  it('dispositivo existente: reporta priorFeedbackCount; vínculo do cliente é best-effort fora da tx', async () => {
    const fp = 'itest-fp-existing';

    const first = await persistQrFeedback({
      enterpriseId: A,
      collectionPointId: QR_GERAL_A,
      feedbackId: crypto.randomUUID(),
      message: 'primeiro',
      rating: 5,
      trackedDevice: null,
      customerId: null,
      deviceFingerprint: fp,
      userAgent: 'itest-ua',
      clientIP: '127.0.0.1',
      answerRows: [],
      subanswerRows: [],
    });
    await updateTrackedDeviceCounters({
      id: first.trackedDeviceId,
      feedbackCount: 1,
      userAgent: 'itest-ua',
      clientIP: '127.0.0.1',
    });

    const existing = await findTrackedDevice({ enterpriseId: A, deviceFingerprint: fp });
    expect(existing?.customerId).toBeNull();

    const cust = await insertCustomer({
      enterpriseId: A,
      name: 'Itest',
      email: 'itest-cust-existing@x.local',
      gender: null,
    });

    const second = await persistQrFeedback({
      enterpriseId: A,
      collectionPointId: QR_GERAL_A,
      feedbackId: crypto.randomUUID(),
      message: 'segundo',
      rating: 4,
      trackedDevice: existing,
      customerId: cust!.id,
      deviceFingerprint: fp,
      userAgent: 'itest-ua',
      clientIP: '127.0.0.1',
      answerRows: [],
      subanswerRows: [],
    });

    expect(second.trackedDeviceId).toBe(first.trackedDeviceId);
    expect(second.priorFeedbackCount).toBe(1);
    // A transação NÃO vincula o cliente do device existente (semântica não-fatal).
    expect((await findTrackedDevice({ enterpriseId: A, deviceFingerprint: fp }))?.customerId).toBeNull();

    // O vínculo é feito à parte, best-effort.
    await linkTrackedDeviceCustomer({ id: second.trackedDeviceId, customerId: cust!.id });
    const afterLink = await findTrackedDevice({ enterpriseId: A, deviceFingerprint: fp });
    expect(afterLink?.customerId).toBe(cust!.id);
  });
});

describe('[Integração] leituras do submit anônimo — tenant-scoped', () => {
  it('ISOLAMENTO: device e dedup diária são escopados por empresa', async () => {
    const fp = 'itest-fp-isolation';
    const r = await persistQrFeedback({
      enterpriseId: A,
      collectionPointId: QR_GERAL_A,
      feedbackId: crypto.randomUUID(),
      message: 'iso',
      rating: 5,
      trackedDevice: null,
      customerId: null,
      deviceFingerprint: fp,
      userAgent: 'itest-ua',
      clientIP: '127.0.0.1',
      answerRows: [],
      subanswerRows: [],
    });

    // Mesmo fingerprint: A enxerga, B não.
    expect(await findTrackedDevice({ enterpriseId: A, deviceFingerprint: fp })).not.toBeNull();
    expect(await findTrackedDevice({ enterpriseId: B, deviceFingerprint: fp })).toBeNull();

    const since = startOfTodayIso();
    // Enviou hoje neste ponto → dedup detecta.
    expect(
      await hasFeedbackSince({
        enterpriseId: A,
        trackedDeviceId: r.trackedDeviceId,
        collectionPointId: QR_GERAL_A,
        sinceIso: since,
      }),
    ).toBe(true);

    // Amanhã já não conta.
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    expect(
      await hasFeedbackSince({
        enterpriseId: A,
        trackedDeviceId: r.trackedDeviceId,
        collectionPointId: QR_GERAL_A,
        sinceIso: tomorrow.toISOString(),
      }),
    ).toBe(false);

    // Sob a empresa errada (B) ou em outro ponto → não conta.
    expect(
      await hasFeedbackSince({
        enterpriseId: B,
        trackedDeviceId: r.trackedDeviceId,
        collectionPointId: QR_GERAL_A,
        sinceIso: since,
      }),
    ).toBe(false);
    expect(
      await hasFeedbackSince({
        enterpriseId: A,
        trackedDeviceId: r.trackedDeviceId,
        collectionPointId: QR_GERAL_B,
        sinceIso: since,
      }),
    ).toBe(false);
  });

  it('ISOLAMENTO: findCustomerByEmail não vaza cliente entre empresas', async () => {
    const email = 'itest-cust-iso@x.local';
    const c = await insertCustomer({ enterpriseId: A, name: 'Iso', email, gender: 'Masculino' });
    expect(c?.id).toBeTruthy();

    expect((await findCustomerByEmail({ enterpriseId: A, email }))?.id).toBe(c!.id);
    expect(await findCustomerByEmail({ enterpriseId: B, email })).toBeNull();
  });
});
