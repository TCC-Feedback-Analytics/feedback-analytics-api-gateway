-- ============================================================================
-- CUTOVER (complemento do PR2) — FK enterprise.auth_user_id -> public.user
-- ============================================================================
-- Fecha a lacuna deixada pelo betterauth-enable.sql: aquele script REMOVEU a FK
-- enterprise.auth_user_id -> auth.users (os usuarios passaram a viver em
-- public.user) mas deixou para o "PR2" recria-la apontando para public.user — o
-- que nunca foi feito. Sem esta FK, deletar um usuario (public.user) NAO
-- cascateia para a empresa: a enterprise e TODOS os dados de negocio ficam
-- orfaos (auth_user_id apontando para um usuario inexistente).
--
-- Com esta FK (ON DELETE CASCADE): deletar public.user apaga a enterprise, e a
-- cascata JA existente da enterprise apaga feedbacks, catalogo, pontos de
-- coleta, perguntas, analises e relatorios.
--
--   psql "$DATABASE_URL" -f db/cutover/enterprise-user-fk.sql
--
-- E IDEMPOTENTE. Pre-requisito: betterauth-enable.sql ja aplicado (public.user
-- existe). Seguro em bases grandes: adiciona a FK como NOT VALID (sem varredura
-- nem lock longo) e so a VALIDA se nao houver empresas orfas.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  r RECORD;
  orphan_count int;
  enterprise_oid oid := to_regclass('public.enterprise');
  user_oid       oid := to_regclass('public."user"');
BEGIN
  -- to_regclass devolve NULL (sem erro) se o objeto nao existir.
  IF enterprise_oid IS NULL OR user_oid IS NULL THEN
    RAISE NOTICE 'public.enterprise ou public.user inexistente — rode betterauth-enable.sql antes. Nada a fazer.';
    RETURN;
  END IF;

  -- 1) Remove qualquer FK atual em enterprise.auth_user_id (resquicio da FK para
  --    auth.users OU uma execucao anterior deste script) -> idempotente.
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_attribute a
      ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
    WHERE con.conrelid = enterprise_oid
      AND con.contype = 'f'
      AND a.attname = 'auth_user_id'
  LOOP
    EXECUTE format('ALTER TABLE public.enterprise DROP CONSTRAINT %I', r.conname);
  END LOOP;

  -- 2) (Re)cria a FK -> public.user com ON DELETE CASCADE. NOT VALID para nao
  --    falhar se houver empresas orfas legadas; a cascata ja vale para os
  --    deletes FUTUROS mesmo com a constraint NOT VALID.
  ALTER TABLE public.enterprise
    ADD CONSTRAINT enterprise_auth_user_id_user_fkey
    FOREIGN KEY (auth_user_id) REFERENCES public."user"(id)
    ON DELETE CASCADE
    NOT VALID;

  -- 3) Orfas = auth_user_id sem public.user correspondente. Se 0, valida a FK
  --    (fica 100% VALID). Se houver, deixa NOT VALID e avisa como resolver.
  SELECT count(*) INTO orphan_count
  FROM public.enterprise e
  WHERE NOT EXISTS (SELECT 1 FROM public."user" u WHERE u.id = e.auth_user_id);

  IF orphan_count = 0 THEN
    ALTER TABLE public.enterprise
      VALIDATE CONSTRAINT enterprise_auth_user_id_user_fkey;
    RAISE NOTICE 'OK: FK enterprise.auth_user_id -> public.user criada e VALIDADA (0 orfas).';
  ELSE
    RAISE NOTICE 'ATENCAO: FK criada como NOT VALID — % empresa(s) orfa(s) sem public.user.', orphan_count;
    RAISE NOTICE 'Liste com: SELECT id, auth_user_id, document FROM public.enterprise e WHERE NOT EXISTS (SELECT 1 FROM public."user" u WHERE u.id = e.auth_user_id);';
    RAISE NOTICE 'Apos resolver, rode: ALTER TABLE public.enterprise VALIDATE CONSTRAINT enterprise_auth_user_id_user_fkey;';
  END IF;
END $$;

COMMIT;
