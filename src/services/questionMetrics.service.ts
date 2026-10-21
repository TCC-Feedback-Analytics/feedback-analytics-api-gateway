import { inArray } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { scopedFeedbackWhere } from '../db/tenantScope.js';
import {
  feedback,
  feedbackQuestionAnswers,
  feedbackSubquestionAnswers,
} from '../../drizzle/schema.js';
import type { MetricsPeriod } from '../libs/period.js';
import {
  ratingStats,
  csatTopTwoBox,
  confidenceTier,
  spearmanCorrelation,
} from '../libs/statistics/index.js';
import {
  fetchQuestionDefsScoped,
  fetchSubquestionDefsScoped,
} from '../repositories/feedbackQuestions.repository.js';

type AnswerValueKey = 'PESSIMO' | 'RUIM' | 'MEDIANA' | 'BOA' | 'OTIMA';

/**
 * Estado de uma redação de pergunta/subpergunta nas métricas:
 * - `current`: ativa e com o texto atual da config (aparece em "Atuais").
 * - `deactivated`: a config ainda tem esta redação, mas está desativada (toggle off).
 *   Reativar a traz de volta para "Atuais" com todo o histórico (id estável).
 * - `past`: redação antiga (texto editado) ou pergunta removida da config.
 */
export type QuestionMetricStatus = 'current' | 'deactivated' | 'past';

type ConfigEntry = { text: string; isActive: boolean } | undefined;

type QuestionAnswerAgg = {
  /** question_id ou subquestion_id (estável; a redação pode mudar com o tempo). */
  id: string;
  /** Snapshot da redação exata respondida pelo cliente (já trimada). */
  text: string;
  counts: Record<number, number>;
  distribution: Record<AnswerValueKey, number>;
  /** (nota da resposta, estrelas do mesmo feedback): base do "o que mais pesa na nota". */
  pairs: Array<[number, number]>;
};

/**
 * Separador para a chave composta (id + redação). Cada redação distinta de uma
 * mesma pergunta vira uma entrada própria — assim "Atuais" e "Antigas" não se misturam.
 */
const AGG_KEY_SEP = String.fromCharCode(1);

function newAnswerAgg(id: string, text: string): QuestionAnswerAgg {
  return {
    id,
    text,
    counts: {},
    distribution: { PESSIMO: 0, RUIM: 0, MEDIANA: 0, BOA: 0, OTIMA: 0 },
    pairs: [],
  };
}

function addAnswerToAgg(
  map: Map<string, QuestionAnswerAgg>,
  id: string,
  text: string,
  answerValue: AnswerValueKey,
  answerScore: number,
  starRating?: number | null,
) {
  const key = `${id}${AGG_KEY_SEP}${text}`;
  const acc = map.get(key) ?? newAnswerAgg(id, text);
  acc.counts[answerScore] = (acc.counts[answerScore] ?? 0) + 1;
  acc.distribution[answerValue] += 1;
  if (starRating != null) acc.pairs.push([answerScore, starRating]);
  map.set(key, acc);
}

function aggToMetricFields(agg: QuestionAnswerAgg) {
  const rs = ratingStats(agg.counts);
  return {
    count: rs.n,
    mean: rs.mean,
    ci: rs.ci,
    satisfiedPct: csatTopTwoBox(agg.counts).pct,
    distribution: agg.distribution,
    confidenceTier: confidenceTier(rs.n),
  };
}

/** Estado da redação de uma pergunta vs a config atual (ver QuestionMetricStatus). */
function questionMetricStatus(cfg: ConfigEntry, snapshot: string): QuestionMetricStatus {
  if (cfg && cfg.text === snapshot) return cfg.isActive ? 'current' : 'deactivated';
  return 'past';
}

/** Estado de uma subpergunta: "atual" só com pai ativo + subpergunta ativa + texto atual. */
function subMetricStatus(
  parentCfg: ConfigEntry,
  subCfg: ConfigEntry,
  snapshot: string,
): QuestionMetricStatus {
  if (subCfg && subCfg.text === snapshot) {
    return parentCfg?.isActive === true && subCfg.isActive === true ? 'current' : 'deactivated';
  }
  return 'past';
}

function buildSubMetric(agg: QuestionAnswerAgg, status: QuestionMetricStatus) {
  return { subquestion_id: agg.id, text: agg.text, ...aggToMetricFields(agg), status };
}

export type SubquestionMetric = ReturnType<typeof buildSubMetric>;

export type QuestionMetric = ReturnType<typeof aggToMetricFields> & {
  question_id: string;
  text: string;
  ratingWeight: ReturnType<typeof spearmanCorrelation>;
  status: QuestionMetricStatus;
  subquestions: SubquestionMetric[];
};

/**
 * Métricas por pergunta/subpergunta (escala 1–5), agregadas no escopo: nota
 * média + IC, % satisfeitos (BOA+ÓTIMA), distribuição e camada de confiança.
 * Determinístico — só estatística sobre as respostas estruturadas. Ordenado
 * pior→melhor (menor nota no topo). Base de `/feedbacks/questions` e do
 * diagnóstico do escopo.
 */
export async function computeScopedQuestionMetrics(params: {
  enterpriseId: string;
  collectionPointIds: string[] | null;
  period: MetricsPeriod;
}): Promise<QuestionMetric[]> {
  const { enterpriseId, collectionPointIds, period } = params;
  if (collectionPointIds && collectionPointIds.length === 0) return [];

  // Feedbacks do escopo (SEMPRE por enterprise_id via scopedFeedbackWhere).
  const feedbackRows = await getDb()
    .select({ id: feedback.id, rating: feedback.rating })
    .from(feedback)
    .where(scopedFeedbackWhere(enterpriseId, collectionPointIds, period));

  const feedbackIds = feedbackRows.map((f) => f.id);
  // Estrelas de cada feedback: o "o que mais pesa na nota" cruza com a resposta de cada pergunta.
  const starsByFeedback = new Map(feedbackRows.map((f) => [f.id, f.rating]));
  if (feedbackIds.length === 0) return [];

  // Respostas das perguntas → agrega por pergunta. Isolamento transitivo: os
  // feedbackIds já vêm tenant-scoped.
  const answerRows = await getDb()
    .select({
      feedback_id: feedbackQuestionAnswers.feedbackId,
      question_id: feedbackQuestionAnswers.questionId,
      question_text_snapshot: feedbackQuestionAnswers.questionTextSnapshot,
      answer_value: feedbackQuestionAnswers.answerValue,
      answer_score: feedbackQuestionAnswers.answerScore,
    })
    .from(feedbackQuestionAnswers)
    .where(inArray(feedbackQuestionAnswers.feedbackId, feedbackIds));

  // Agrupa as respostas por (question_id + redação do snapshot): cada redação
  // distinta vira uma entrada própria, para separar "atuais" de "antigas".
  const questionAgg = new Map<string, QuestionAnswerAgg>();
  for (const row of answerRows) {
    addAnswerToAgg(
      questionAgg,
      row.question_id,
      String(row.question_text_snapshot ?? '').trim(),
      row.answer_value as AnswerValueKey,
      row.answer_score,
      starsByFeedback.get(row.feedback_id),
    );
  }

  // Respostas das subperguntas → agrega por (subquestion_id + redação).
  const subAnswerRows = await getDb()
    .select({
      subquestion_id: feedbackSubquestionAnswers.subquestionId,
      subquestion_text_snapshot: feedbackSubquestionAnswers.subquestionTextSnapshot,
      answer_value: feedbackSubquestionAnswers.answerValue,
      answer_score: feedbackSubquestionAnswers.answerScore,
    })
    .from(feedbackSubquestionAnswers)
    .where(inArray(feedbackSubquestionAnswers.feedbackId, feedbackIds));

  const subAgg = new Map<string, QuestionAnswerAgg>();
  for (const row of subAnswerRows) {
    addAnswerToAgg(subAgg, row.subquestion_id, String(row.subquestion_text_snapshot ?? '').trim(), row.answer_value as AnswerValueKey, row.answer_score);
  }

  // Config ATUAL das perguntas (texto + is_active) por id — base da classificação
  // "atual" (ativa + texto igual ao configurado) vs "antiga" (editada/removida).
  // eq(enterprise_id) OBRIGATÓRIO no repo (o Drizzle ignora a RLS).
  const currentQ = new Map<string, { text: string; isActive: boolean }>();
  const questionIds = [...new Set([...questionAgg.values()].map((a) => a.id))];
  for (const def of await fetchQuestionDefsScoped(enterpriseId, questionIds)) {
    currentQ.set(def.id, { text: String(def.questionText ?? '').trim(), isActive: def.isActive === true });
  }

  // Config ATUAL das subperguntas (texto + is_active) + mapeamento subpergunta → pai.
  // O repo reforça o tenant via JOIN na pergunta-pai (enterprise_id).
  const subParentBySubId = new Map<string, string>();
  const currentSub = new Map<string, { text: string; isActive: boolean }>();
  const subIds = [...new Set([...subAgg.values()].map((a) => a.id))];
  for (const def of await fetchSubquestionDefsScoped(enterpriseId, subIds)) {
    subParentBySubId.set(def.id, def.questionId);
    currentSub.set(def.id, { text: String(def.subquestionText ?? '').trim(), isActive: def.isActive === true });
  }

  // Subperguntas agrupadas por pergunta-pai (todas as redações; cada uma com status).
  const subsByQuestion = new Map<string, SubquestionMetric[]>();
  for (const agg of subAgg.values()) {
    const parentId = subParentBySubId.get(agg.id);
    if (!parentId) continue;
    const status = subMetricStatus(currentQ.get(parentId), currentSub.get(agg.id), agg.text);
    const list = subsByQuestion.get(parentId) ?? [];
    list.push(buildSubMetric(agg, status));
    subsByQuestion.set(parentId, list);
  }
  for (const list of subsByQuestion.values()) {
    list.sort((a, b) => a.mean - b.mean);
  }

  // Agrupa as entradas por question_id para eleger a redação que hospeda as
  // subperguntas (a redação "viva" — a que casa com o texto da config, seja
  // atual ou desativada; senão a primeira) — evita duplicar entre redações.
  const entriesByQid = new Map<string, QuestionAnswerAgg[]>();
  for (const agg of questionAgg.values()) {
    const list = entriesByQid.get(agg.id) ?? [];
    list.push(agg);
    entriesByQid.set(agg.id, list);
  }

  return [...entriesByQid.entries()]
    .flatMap(([qid, aggs]) => {
      const cfg = currentQ.get(qid);
      const host = aggs.find((a) => cfg?.text === a.text) ?? aggs[0];
      return aggs.map((agg) => ({
        question_id: qid,
        text: agg.text,
        ...aggToMetricFields(agg),
        // O quanto a nota da pergunta anda junto com as estrelas (Spearman + IC).
        ratingWeight: spearmanCorrelation(agg.pairs),
        status: questionMetricStatus(cfg, agg.text),
        subquestions: agg === host ? (subsByQuestion.get(qid) ?? []) : [],
      }));
    })
    .sort((a, b) => a.mean - b.mean);
}
