/**
 * Estatística para análise de feedback — métodos comprovados de mercado.
 *
 * Funções PURAS (sem efeitos colaterais), testáveis isoladamente. A camada de
 * controllers usa estas funções para enriquecer as respostas de stats/análise.
 *
 * Referências: Net Sentiment Score (Thematic), Net Satisfaction / CSAT Top-2-Box
 * (Qualtrics/ACSI), intervalo de Wilson (Brown, Cai & DasGupta 2001), intervalo t
 * para média, camadas de confiança (Cochran), média Bayesiana (IMDb).
 */

/** Intervalo (limites inferior/superior). A UNIDADE depende do contexto do campo. */
export type Interval = { lower: number; upper: number };

/** Camada de confiança derivada do tamanho da amostra (n). */
export type ConfidenceTier = 'insufficient' | 'low' | 'moderate' | 'good';

/** z para 95% bicaudal. */
const Z_95 = 1.959963984540054;

/** Valores críticos de t (95% bicaudal) por graus de liberdade 1..30; acima usa z. */
const T_95: Record<number, number> = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
  8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.16, 14: 2.145,
  15: 2.131, 16: 2.12, 17: 2.11, 18: 2.101, 19: 2.093, 20: 2.086, 21: 2.08,
  22: 2.074, 23: 2.069, 24: 2.064, 25: 2.06, 26: 2.056, 27: 2.052, 28: 2.048,
  29: 2.045, 30: 2.042,
};

function tCritical(df: number): number {
  if (df <= 0) return Z_95;
  if (df <= 30) return T_95[df];
  return Z_95;
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Intervalo de confiança de Wilson (95% por padrão) para uma proporção x/n.
 * Retorna fração em [0,1]. Preciso em n pequeno e perto de 0/1 (ao contrário do
 * Wald). Use `pctInterval` para já obter em porcentagem.
 */
export function wilsonInterval(x: number, n: number, z = Z_95): Interval {
  if (n <= 0) return { lower: 0, upper: 0 };
  const p = x / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    lower: Math.max(0, (centre - margin) / denom),
    upper: Math.min(1, (centre + margin) / denom),
  };
}

/** Limite inferior de Wilson — chave de ranking justa para amostras pequenas. */
export function wilsonLowerBound(x: number, n: number, z = Z_95): number {
  if (n <= 0) return 0;
  return wilsonInterval(x, n, z).lower;
}

/** Intervalo de Wilson já em porcentagem (0..100), arredondado a 1 casa. */
export function pctInterval(x: number, n: number, z = Z_95): Interval {
  const ci = wilsonInterval(x, n, z);
  return { lower: round(ci.lower * 100, 1), upper: round(ci.upper * 100, 1) };
}

/** Net Sentiment Score = (pos - neg)/total * 100 → [-100, 100]. */
export function netSentimentScore(positive: number, negative: number, total: number): number {
  if (total <= 0) return 0;
  return round(((positive - negative) / total) * 100, 1);
}

/** Net Satisfaction = %(top-2) − %(bottom-2) → [-100, 100]. */
export function netSatisfaction(top2: number, bottom2: number, total: number): number {
  if (total <= 0) return 0;
  return round(((top2 - bottom2) / total) * 100, 1);
}

/** Camada de confiança pelo n (Cochran): <10 insuficiente, <30 baixa, <100 moderada, senão boa. */
export function confidenceTier(n: number): ConfidenceTier {
  if (n < 10) return 'insufficient';
  if (n < 30) return 'low';
  if (n < 100) return 'moderate';
  return 'good';
}

export type RatingStats = {
  n: number;
  mean: number;
  sd: number;
  se: number;
  /** IC t da média, em unidades de nota e clampado em [1,5]. */
  ci: Interval;
};

/**
 * Estatística de notas 1..5 a partir das contagens por nota.
 * `counts` é um mapa { 1: n1, ..., 5: n5 } (chaves ausentes = 0).
 */
export function ratingStats(counts: Record<number, number>): RatingStats {
  let n = 0;
  let sum = 0;
  for (let k = 1; k <= 5; k++) {
    const c = counts[k] ?? 0;
    n += c;
    sum += k * c;
  }
  if (n === 0) return { n: 0, mean: 0, sd: 0, se: 0, ci: { lower: 0, upper: 0 } };

  const mean = sum / n;
  let ssd = 0;
  for (let k = 1; k <= 5; k++) {
    ssd += (counts[k] ?? 0) * (k - mean) ** 2;
  }
  const variance = n > 1 ? ssd / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  const se = sd / Math.sqrt(n);
  const margin = tCritical(n - 1) * se;

  return {
    n,
    mean: round(mean, 2),
    sd: round(sd, 3),
    se: round(se, 3),
    ci: {
      lower: round(Math.max(1, mean - margin), 2),
      upper: round(Math.min(5, mean + margin), 2),
    },
  };
}

export type CsatResult = {
  /** % satisfeitos (notas 4-5), 0..100. */
  pct: number;
  /** IC de Wilson em porcentagem (0..100). */
  ci: Interval;
};

/** CSAT Top-2-Box: % de notas 4-5 sobre o total, com IC de Wilson. */
export function csatTopTwoBox(counts: Record<number, number>): CsatResult {
  let n = 0;
  let top2 = 0;
  for (let k = 1; k <= 5; k++) {
    const c = counts[k] ?? 0;
    n += c;
    if (k >= 4) top2 += c;
  }
  if (n === 0) return { pct: 0, ci: { lower: 0, upper: 0 } };
  return { pct: round((top2 / n) * 100, 1), ci: pctInterval(top2, n) };
}

/**
 * Média Bayesiana (encolhimento estilo IMDb) — puxa a média de um item com
 * poucos votos em direção à média global. WR = (v·R + m·C)/(v + m).
 * v = nº de votos do item, R = média do item, C = média global (prior),
 * m = força do prior (nº de "votos" equivalentes).
 */
export function bayesianAverage(
  itemMean: number,
  itemCount: number,
  globalMean: number,
  m: number,
): number {
  if (itemCount + m <= 0) return round(globalMean, 2);
  return round((itemCount * itemMean + m * globalMean) / (itemCount + m), 2);
}

export type Correlation = {
  /** Coeficiente de Spearman, em [-1, 1]. */
  r: number;
  /** IC 95% (Fisher z com o erro padrão de Bonett–Wright para Spearman). */
  ci: Interval;
  /** Pares usados no cálculo. */
  n: number;
};

/** Postos médios: valores empatados recebem a média dos postos que ocupariam. */
function averageRanks(values: number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].value === order[i].value) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k].index] = rank;
    i = j + 1;
  }
  return ranks;
}

/**
 * Correlação de Spearman entre duas notas do MESMO feedback (ex.: a nota de uma
 * pergunta e as estrelas). Robusta para escalas de 1 a 5 com muitos empates:
 * é a correlação de Pearson dos postos médios. Diz o quanto as duas andam
 * juntas, não que uma causa a outra. `null` com menos de 4 pares ou quando uma
 * das notas não varia (todas iguais).
 */
export function spearmanCorrelation(pairs: ReadonlyArray<readonly [number, number]>, z = Z_95): Correlation | null {
  const n = pairs.length;
  if (n < 4) return null;

  const rx = averageRanks(pairs.map((pair) => pair[0]));
  const ry = averageRanks(pairs.map((pair) => pair[1]));
  const meanRank = (n + 1) / 2;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = rx[i] - meanRank;
    const dy = ry[i] - meanRank;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;

  const r = Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
  const fisher = Math.atanh(Math.max(-0.9999, Math.min(0.9999, r)));
  const se = Math.sqrt((1 + (r * r) / 2) / (n - 3));
  return {
    r: round(r, 3),
    ci: { lower: round(Math.tanh(fisher - z * se), 3), upper: round(Math.tanh(fisher + z * se), 3) },
    n,
  };
}
