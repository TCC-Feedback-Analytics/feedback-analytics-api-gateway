-- Apaga os tokens do Google das contas criadas antes do hook discardOAuthTokens (src/auth/auth.ts).
-- O hook só limpa a conta quando a pessoa entra de novo; esta migration limpa as antigas de uma vez.
-- O sistema não chama o Google depois do login, então nenhum fluxo depende destes tokens.
-- As colunas continuam: o Better Auth espera por elas.
UPDATE public.account
SET access_token = NULL, refresh_token = NULL, id_token = NULL
WHERE provider_id = 'google'
  AND (access_token IS NOT NULL OR refresh_token IS NOT NULL OR id_token IS NOT NULL);
