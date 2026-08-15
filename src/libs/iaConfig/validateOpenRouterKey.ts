/**
 * Valida uma chave OpenRouter chamando `GET /auth/key` (endpoint barato que só
 * confere a credencial). Retorna `true` em 200. Dá ao usuário feedback imediato
 * ao salvar, em vez de descobrir que a chave é inválida só na 1ª análise.
 */
const OPENROUTER_AUTH_KEY_URL = 'https://openrouter.ai/api/v1/auth/key';

export async function validateOpenRouterKey(apiKey: string): Promise<boolean> {
  try {
    const response = await fetch(OPENROUTER_AUTH_KEY_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return response.ok;
  } catch {
    // Erro de rede não deve mascarar como "chave inválida" indefinidamente, mas
    // aqui tratamos como não-validada (o usuário tenta de novo).
    return false;
  }
}
