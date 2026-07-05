import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { qrcodeFeedbackSchema } from '@feedback/lib-shared/schemas/public/feedbackSchema';
import {
  API_ERROR_COLLECTION_POINT_ERROR,
  API_ERROR_COLLECTION_POINT_NOT_FOUND,
  API_ERROR_DEVICE_ALREADY_SUBMITTED,
  API_ERROR_DEVICE_BLOCKED,
  API_ERROR_DEVICE_CHECK_FAILED,
  API_ERROR_DEVICE_CREATION_FAILED,
  API_ERROR_ENTERPRISE_NOT_FOUND,
  API_ERROR_FEEDBACK_INSERT_FAILED,
  API_ERROR_INVALID_PAYLOAD,
} from '../../config/errors.js';
import { sendTypedError } from '../../utils/sendTypedError.js';
import { fetchActiveQuestionsForScope } from '../../repositories/publicQuestions.repository.js';
import {
  getPublicEnterpriseById,
  resolveQrCollectionPoint,
} from '../../repositories/publicEnterprise.repository.js';
import {
  QrFeedbackWriteError,
  findCustomerByEmail,
  findTrackedDevice,
  hasFeedbackSince,
  insertCustomer,
  linkTrackedDeviceCustomer,
  persistQrFeedback,
  updateTrackedDeviceCounters,
  type NewQuestionAnswer,
  type NewSubquestionAnswer,
} from '../../repositories/qrFeedback.repository.js';

function mapAnswerScore(answerValue: string): number {
  switch (answerValue) {
    case 'PESSIMO': return 1;
    case 'RUIM': return 2;
    case 'MEDIANA': return 3;
    case 'BOA': return 4;
    case 'OTIMA': return 5;
    default: return 0;
  }
}

function mapGenderForDb(gender?: string | null): string | null {
  if (!gender) return null;
  const genderMap: Record<string, string> = {
    masculino: 'Masculino',
    feminino: 'Feminino',
    outro: 'Outro',
    prefiro_nao_informar: 'Não Informado',
  };
  return genderMap[gender] || null;
}

export async function submitQrCodeFeedbackController(req: Request, res: Response) {
  const parsed = qrcodeFeedbackSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD);
  }

  const payload = parsed.data;

  // 1. Empresa existe? (view enterprise_public)
  const enterprise = await getPublicEnterpriseById(payload.enterprise_id);
  if (!enterprise) {
    return sendTypedError(res, 404, API_ERROR_ENTERPRISE_NOT_FOUND);
  }

  // 2. Fingerprint do dispositivo — corte do "dia" em horário LOCAL (decisão
  // deliberada: preserva o comportamento em produção; em prod o servidor é UTC).
  const userAgent = req.get('user-agent') || '';
  const clientIP = req.ip || req.socket?.remoteAddress || '127.0.0.1';

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayEpoch = Math.floor(today.getTime() / 1000);

  const fingerprintData = `${userAgent}|${clientIP}|${dayEpoch}`;
  const deviceFingerprint = crypto.createHash('md5').update(fingerprintData).digest('hex');

  // 3. Ponto de coleta QR ATIVO do escopo (por id / catalog_item / "geral").
  let collectionPoint;
  try {
    collectionPoint = await resolveQrCollectionPoint({
      enterpriseId: payload.enterprise_id,
      collectionPointId: payload.collection_point_id ?? null,
      catalogItemId: payload.catalog_item_id ?? null,
    });
  } catch (err) {
    console.error('Erro ao buscar collection_point:', err);
    return sendTypedError(res, 500, API_ERROR_COLLECTION_POINT_ERROR);
  }

  if (!collectionPoint) {
    return sendTypedError(res, 404, API_ERROR_COLLECTION_POINT_NOT_FOUND);
  }

  const contextScope: 'COMPANY' | 'PRODUCT' | 'SERVICE' | 'DEPARTMENT' =
    collectionPoint.catalogItemKind === 'PRODUCT' ||
    collectionPoint.catalogItemKind === 'SERVICE' ||
    collectionPoint.catalogItemKind === 'DEPARTMENT'
      ? collectionPoint.catalogItemKind
      : 'COMPANY';

  // 4. Perguntas ativas do escopo (contagem variável, sem fallback para Geral).
  const { data: currentQuestions, error: currentQuestionsError } =
    await fetchActiveQuestionsForScope({
      enterpriseId: payload.enterprise_id,
      scopeType: contextScope,
      catalogItemId: collectionPoint.catalogItemId ?? null,
    });

  if (currentQuestionsError) {
    console.error('Erro ao carregar perguntas do contexto do feedback:', currentQuestionsError);
    return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD);
  }

  const normalizedQuestions = (currentQuestions ?? []).map((question) => ({
    id: String(question.id),
    question_order: Number(question.question_order),
    question_text: String(question.question_text ?? ''),
    subquestions: Array.isArray(question.subquestions)
      ? question.subquestions
          .filter((subquestion) => subquestion?.is_active === true)
          .map((subquestion) => ({
            id: String(subquestion.id),
            question_id: String(subquestion.question_id),
            subquestion_order: Number(subquestion.subquestion_order),
            subquestion_text: String(subquestion.subquestion_text ?? ''),
          }))
          .sort((left, right) => left.subquestion_order - right.subquestion_order)
      : [],
  }));

  // 5. Anti-tampering: respostas precisam bater EXATAMENTE com as perguntas ativas.
  const allowedQuestionIds = new Set(normalizedQuestions.map((question) => question.id));
  const payloadQuestionIds = payload.answers.map((answer) => answer.question_id);

  if (
    payload.answers.length !== normalizedQuestions.length ||
    new Set(payloadQuestionIds).size !== normalizedQuestions.length ||
    payloadQuestionIds.some((questionId) => !allowedQuestionIds.has(questionId))
  ) {
    return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD);
  }

  const activeSubquestions = normalizedQuestions.flatMap((question) => question.subquestions);
  const payloadSubanswers = payload.subanswers ?? [];
  const allowedSubquestionIds = new Set(activeSubquestions.map((subquestion) => subquestion.id));
  const payloadSubquestionIds = payloadSubanswers.map((subanswer) => subanswer.subquestion_id);

  if (
    payloadSubanswers.length !== activeSubquestions.length ||
    new Set(payloadSubquestionIds).size !== payloadSubanswers.length ||
    payloadSubquestionIds.some((subquestionId) => !allowedSubquestionIds.has(subquestionId))
  ) {
    return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD);
  }

  // 6. Monta as linhas de resposta com snapshot + score, e valida o score ANTES
  // de qualquer escrita (evita feedback órfão que o fluxo Supabase deixava).
  const questionById = new Map(normalizedQuestions.map((question) => [question.id, question]));
  const subquestionById = new Map(activeSubquestions.map((subquestion) => [subquestion.id, subquestion]));

  const answerRows: NewQuestionAnswer[] = payload.answers.map((answer) => ({
    questionId: answer.question_id,
    questionTextSnapshot: questionById.get(answer.question_id)?.question_text ?? '',
    answerValue: answer.answer_value,
    answerScore: mapAnswerScore(answer.answer_value),
  }));

  const subanswerRows: NewSubquestionAnswer[] = payloadSubanswers.map((subanswer) => ({
    subquestionId: subanswer.subquestion_id,
    subquestionTextSnapshot: subquestionById.get(subanswer.subquestion_id)?.subquestion_text ?? '',
    answerValue: subanswer.answer_value,
    answerScore: mapAnswerScore(subanswer.answer_value),
  }));

  if (
    answerRows.some((row) => row.answerScore === 0) ||
    subanswerRows.some((row) => row.answerScore === 0)
  ) {
    return sendTypedError(res, 400, API_ERROR_INVALID_PAYLOAD);
  }

  // 7. Dispositivo rastreado (bloqueio → 403).
  let trackedDevice;
  try {
    trackedDevice = await findTrackedDevice({
      enterpriseId: payload.enterprise_id,
      deviceFingerprint,
    });
  } catch (err) {
    console.error('Erro ao verificar dispositivo:', err);
    return sendTypedError(res, 500, API_ERROR_DEVICE_CHECK_FAILED);
  }

  if (trackedDevice?.isBlocked) {
    return sendTypedError(res, 403, API_ERROR_DEVICE_BLOCKED);
  }

  // 8. Deduplicação diária (mesmo dispositivo + mesmo ponto, no dia) → 409.
  if (trackedDevice?.id) {
    try {
      const alreadySubmitted = await hasFeedbackSince({
        enterpriseId: payload.enterprise_id,
        trackedDeviceId: trackedDevice.id,
        collectionPointId: collectionPoint.id,
        sinceIso: today.toISOString(),
      });
      if (alreadySubmitted) {
        return sendTypedError(res, 409, API_ERROR_DEVICE_ALREADY_SUBMITTED);
      }
    } catch (err) {
      console.error('Erro ao verificar feedback duplicado por QR:', err);
      return sendTypedError(res, 500, API_ERROR_DEVICE_CHECK_FAILED);
    }
  }

  // 9. Cliente (opcional, NÃO-fatal): dedup por e-mail, senão cria.
  let customerId: string | null = null;
  if (payload.customer_name || payload.customer_email) {
    if (payload.customer_email) {
      const existingCustomer = await findCustomerByEmail({
        enterpriseId: payload.enterprise_id,
        email: payload.customer_email,
      });
      if (existingCustomer) customerId = existingCustomer.id;
    }

    if (!customerId) {
      try {
        const newCustomer = await insertCustomer({
          enterpriseId: payload.enterprise_id,
          name: payload.customer_name || null,
          email: payload.customer_email || null,
          gender: mapGenderForDb(payload.customer_gender),
        });
        customerId = newCustomer?.id ?? null;
      } catch (err) {
        console.error('Erro ao criar cliente:', err);
      }
    }
  }

  // 10. Escrita atômica: device + feedback + respostas numa transação.
  const feedbackId = crypto.randomUUID();

  let persisted;
  try {
    persisted = await persistQrFeedback({
      enterpriseId: payload.enterprise_id,
      collectionPointId: collectionPoint.id,
      feedbackId,
      message: payload.message,
      rating: payload.rating,
      trackedDevice,
      customerId,
      deviceFingerprint,
      userAgent,
      clientIP,
      answerRows,
      subanswerRows,
    });
  } catch (err) {
    if (err instanceof QrFeedbackWriteError && err.failure === 'device_creation') {
      console.error('Erro ao criar dispositivo:', err);
      return sendTypedError(res, 500, API_ERROR_DEVICE_CREATION_FAILED);
    }
    console.error('Erro ao inserir feedback:', err);
    return sendTypedError(res, 500, API_ERROR_FEEDBACK_INSERT_FAILED);
  }

  // 11. Vínculo do cliente ao dispositivo EXISTENTE — best-effort (não-fatal),
  // fora da transação para não invalidar o feedback já gravado.
  if (trackedDevice && customerId && !trackedDevice.customerId) {
    try {
      await linkTrackedDeviceCustomer({ id: persisted.trackedDeviceId, customerId });
    } catch (err) {
      console.error('Erro ao vincular cliente ao dispositivo:', err);
    }
  }

  // 12. Atualização best-effort dos contadores (não invalida o feedback).
  try {
    await updateTrackedDeviceCounters({
      id: persisted.trackedDeviceId,
      feedbackCount: persisted.priorFeedbackCount + 1,
      userAgent,
      clientIP,
    });
  } catch (err) {
    console.error('Erro ao atualizar dispositivo:', err);
  }

  return res.json({ ok: true });
}
