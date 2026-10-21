/**
 * Força da senha com o zxcvbn (dicionário comum + português): reconhece
 * palavras, nomes, datas, sequências ("123", "abc") e repetições, que a simples
 * contagem de tipos de caractere não pega ("Palavra123palavra" parecia forte).
 * A mesma régua da Web (MIN_PASSWORD_SCORE em @feedback/lib-shared).
 */
import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import * as common from '@zxcvbn-ts/language-common';
import * as ptBr from '@zxcvbn-ts/language-pt-br';
import {
  MIN_PASSWORD_LENGTH,
  MIN_PASSWORD_SCORE,
} from '@feedback/lib-shared/schemas/public/passwordPolicy';

let factory: ZxcvbnFactory | null = null;

function zxcvbn(): ZxcvbnFactory {
  factory ??= new ZxcvbnFactory({
    dictionary: { ...common.dictionary, ...ptBr.dictionary },
    graphs: common.adjacencyGraphs,
    translations: ptBr.translations,
  });
  return factory;
}

/**
 * Cada dado vira as partes que alguém usaria numa senha: o valor inteiro, cada
 * palavra e as palavras juntas, sem acento ("Bom Pão" → "bom", "pao", "bompao").
 */
function userInputTokens(values: Array<string | null | undefined>): string[] {
  const tokens = new Set<string>();
  for (const raw of values) {
    const value = String(raw ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    if (!value) continue;
    tokens.add(value);
    const words = value.split(/[^a-z0-9]+/).filter((word) => word.length >= 3);
    for (const word of words) tokens.add(word);
    if (words.length > 1) tokens.add(words.join(''));
  }
  return [...tokens];
}

/** Nota de 0 a 4. `userInputs`: dados da pessoa (e-mail, nome) que não podem compor a senha. */
export function passwordScore(password: string, userInputs: Array<string | null | undefined> = []): number {
  return zxcvbn().check(password, userInputTokens(userInputs)).score;
}

export function isStrongPassword(password: string, userInputs: Array<string | null | undefined> = []): boolean {
  return password.length >= MIN_PASSWORD_LENGTH && passwordScore(password, userInputs) >= MIN_PASSWORD_SCORE;
}
