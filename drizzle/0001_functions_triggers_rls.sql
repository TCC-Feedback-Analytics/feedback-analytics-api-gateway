-- Migration custom (ADR-0001, Fase 2 · Passo 4): funcoes, triggers e RLS-enable.
-- O 0000 cria tabelas/FKs/indices/view; este 0001 adiciona o restante do schema
-- que o drizzle-kit nao deriva (corpos plpgsql/sql, triggers e ENABLE RLS).
-- Extraido do banco canonico via pg_get_functiondef/pg_get_triggerdef.
-- Pre-requisito p/ rebuild limpo: o schema `auth` (shim em dev / Supabase em prod).
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.can_device_send_feedback(enterprise_id_param uuid, device_fingerprint_param text, collection_point_id_param uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  tracked_device_id_var uuid;
  day_start timestamptz := date_trunc('day', now());
  already_sent boolean := false;
BEGIN
  -- Dispositivo ativo da empresa
  SELECT td.id INTO tracked_device_id_var
  FROM public.tracked_devices
  AS td
  WHERE td.enterprise_id = enterprise_id_param
    AND td.device_fingerprint = device_fingerprint_param
    AND td.is_blocked = FALSE
  LIMIT 1;

  IF tracked_device_id_var IS NULL THEN
    RETURN TRUE;
  END IF;

  IF collection_point_id_param IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.feedback f
      WHERE f.tracked_device_id = tracked_device_id_var
        AND f.collection_point_id = collection_point_id_param
        AND f.created_at >= day_start
    ) INTO already_sent;
  ELSE
    -- Fallback legado: limita por dispositivo no dia (qualquer QR da empresa)
    SELECT EXISTS (
      SELECT 1
      FROM public.feedback f
      WHERE f.tracked_device_id = tracked_device_id_var
        AND f.created_at >= day_start
    ) INTO already_sent;
  END IF;

  RETURN NOT already_sent;
END;
$function$
;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.clean_user_metadata_before_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- sobe phone do metadata se ainda não houver phone
  new.phone := coalesce(new.phone,
                        nullif((coalesce(new.raw_user_meta_data, '{}'::jsonb)->>'phone'), ''));

  -- remove chaves não desejadas do metadata
  new.raw_user_meta_data := coalesce(new.raw_user_meta_data, '{}'::jsonb)
    - 'phone' - 'document' - 'company_name'
    - 'account_type' - 'terms_version' - 'terms_accepted_at'
    - 'email' - 'email_verified' - 'phone_verified';

  return new;
end;
$function$
;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.create_enterprise_on_signup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  meta jsonb := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
  v_account_type       text        := NULLIF(meta->>'account_type', '');
  v_document           text        := NULLIF(meta->>'document', '');
  v_terms_version      text        := NULLIF(meta->>'terms_version', '');
  v_terms_accepted_at  timestamptz := NULLIF(meta->>'terms_accepted_at', '')::timestamptz;
  v_phone              text        := NULLIF(meta->>'phone', '');
  v_enterprise_id      uuid;
  v_exists int;
BEGIN
  -- documento obrigatório
  IF v_document IS NULL THEN
    RAISE EXCEPTION 'document is required' USING ERRCODE = '23514';
  END IF;

  -- valida duplicidade de documento antes de inserir
  SELECT 1 INTO v_exists
  FROM public.enterprise e
  WHERE e.document = v_document
  LIMIT 1;

  IF v_exists = 1 THEN
    RAISE EXCEPTION 'document_already_exists' USING ERRCODE = '23505';
  END IF;

  -- Insere a empresa. A barreira REAL contra documento duplicado é o
  -- UNIQUE(document); o SELECT acima é só otimização de mensagem amigável.
  -- Numa corrida (dois signups simultâneos passam pelo SELECT), o INSERT viola
  -- o UNIQUE e re-erguemos como 'document_already_exists' para manter o 409
  -- consistente. O conflito por auth_user_id segue idempotente no ON CONFLICT
  -- (re-disparo do trigger não duplica), então o único unique_violation que
  -- pode escapar do INSERT é o de documento.
  BEGIN
    INSERT INTO public.enterprise (document, account_type, terms_version, terms_accepted_at, auth_user_id, trial_ends_at, subscription_status)
    VALUES (v_document, v_account_type, v_terms_version, v_terms_accepted_at, NEW.id, NOW() + INTERVAL '4 months', 'TRIAL')
    ON CONFLICT (auth_user_id) DO NOTHING;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'document_already_exists' USING ERRCODE = '23505';
  END;

  -- Busca a enterprise atual para semear perguntas padrão no contexto COMPANY.
  SELECT e.id INTO v_enterprise_id
  FROM public.enterprise e
  WHERE e.auth_user_id = NEW.id
  LIMIT 1;

  IF v_enterprise_id IS NOT NULL AND to_regclass('public.questions_of_feedbacks') IS NOT NULL THEN
    INSERT INTO public.questions_of_feedbacks (
      enterprise_id,
      scope_type,
      catalog_item_id,
      question_order,
      question_text,
      is_active
    )
    SELECT
      v_enterprise_id,
      'COMPANY',
      NULL,
      q.question_order,
      q.question_text,
      true
    FROM (
      VALUES
        (1, 'Como foi sua experiência em relação ao atendimento?'),
        (2, 'O que você achou da qualidade do produto/serviço?'),
        (3, 'Como você avalia a relação entre o valor pago e a qualidade do produto/serviço?')
    ) AS q(question_order, question_text)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.questions_of_feedbacks existing
      WHERE existing.enterprise_id = v_enterprise_id
        AND existing.scope_type = 'COMPANY'
        AND existing.catalog_item_id IS NULL
        AND existing.question_order = q.question_order
    );
  END IF;

  -- valida duplicidade de telefone antes de atualizar auth.users
  IF v_phone IS NOT NULL THEN
    SELECT 1 INTO v_exists
    FROM auth.users u
    WHERE u.phone = v_phone AND u.id <> NEW.id
    LIMIT 1;

    IF v_exists = 1 THEN
      RAISE EXCEPTION 'phone_already_exists' USING ERRCODE = '23505';
    END IF;
  END IF;

  -- atualiza telefone de forma segura e higieniza metadados
  UPDATE auth.users
     SET phone = COALESCE(auth.users.phone, v_phone),
         raw_user_meta_data =
           COALESCE(raw_user_meta_data, '{}'::jsonb)
           - 'phone'
           - 'document'
           - 'company_name'
           - 'account_type'
           - 'terms_version'
           - 'terms_accepted_at'
           - 'email'
           - 'email_verified'
           - 'phone_verified'
   WHERE id = NEW.id;

  RETURN NEW;
END;
$function$
;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.document_exists(p_document text)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists(select 1 from public.enterprise e where e.document = p_document);
$function$
;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.enterprise_public_documents_fn()
 RETURNS TABLE(document text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT DISTINCT document FROM public.enterprise;
$function$
;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.enterprise_public_ids_fn()
 RETURNS TABLE(id uuid, document text, account_type text)
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  SELECT DISTINCT e.id, e.document, e.account_type FROM public.enterprise e;
$function$
;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.generate_device_fingerprint(user_agent_param text, ip_address_param inet)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN md5(
    COALESCE(user_agent_param, '') || '|' || 
    COALESCE(ip_address_param::TEXT, '') || '|' || 
    extract(epoch from date_trunc('day', now()))::TEXT
  );
END;
$function$
;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.jwt_custom_claims()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  SELECT jsonb_build_object(
    'role', 'enterprise',
    'enterprise_id', (select id from public.enterprise where auth_user_id = auth.uid())
  );
$function$
;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.phone_exists(p_phone text)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'auth', 'public'
AS $function$
  select exists(select 1 from auth.users u where u.phone = p_phone);
$function$
;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.register_device_feedback(enterprise_id_param uuid, device_fingerprint_param text, user_agent_param text, ip_address_param inet, customer_id_param uuid DEFAULT NULL::uuid, collection_point_id_param uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  tracked_device_id UUID;
  existing_device RECORD;
BEGIN
  -- Serializa operação por dispositivo para reduzir corrida em cenários concorrentes
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      COALESCE(enterprise_id_param::text, '') || '|' || COALESCE(device_fingerprint_param, ''),
      0
    )
  );

  -- Busca por um dispositivo existente na tabela tracked_devices
  SELECT * INTO existing_device
  FROM public.tracked_devices
  WHERE enterprise_id = enterprise_id_param
    AND device_fingerprint = device_fingerprint_param;

  IF FOUND THEN
    -- Se encontrou, ATUALIZA o registro existente
    UPDATE public.tracked_devices
    SET
      feedback_count = feedback_count + 1,
      last_feedback_at = NOW(),
      user_agent = COALESCE(user_agent_param, user_agent),
      ip_address = COALESCE(ip_address_param, ip_address),
      -- Associa o customer_id se ele for passado, senão mantém o valor antigo
      customer_id = COALESCE(customer_id_param, existing_device.customer_id),
      updated_at = NOW()
    WHERE id = existing_device.id
    RETURNING id INTO tracked_device_id;
  ELSE
    -- Se não encontrou, CRIA um novo registro de dispositivo
    INSERT INTO public.tracked_devices (
      enterprise_id,
      device_fingerprint,
      user_agent,
      ip_address,
      customer_id,
      feedback_count,
      last_feedback_at
    ) VALUES (
      enterprise_id_param,
      device_fingerprint_param,
      user_agent_param,
      ip_address_param,
      customer_id_param,
      1,
      NOW()
    ) RETURNING id INTO tracked_device_id;
  END IF;

  RETURN tracked_device_id;
END;
$function$
;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$
;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.validate_feedback_insights_report_context()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  catalog_kind text;
  catalog_enterprise_id uuid;
BEGIN
  IF NEW.scope_type = 'COMPANY' THEN
    IF NEW.catalog_item_id IS NOT NULL THEN
      RAISE EXCEPTION 'catalog_item_id must be null when scope_type is COMPANY';
    END IF;
  ELSE
    IF NEW.catalog_item_id IS NULL THEN
      RAISE EXCEPTION 'catalog_item_id is required for item scope insights report';
    END IF;

    SELECT ci.kind, ci.enterprise_id
    INTO catalog_kind, catalog_enterprise_id
    FROM public.catalog_items ci
    WHERE ci.id = NEW.catalog_item_id;

    IF catalog_kind IS NULL THEN
      RAISE EXCEPTION 'catalog_item not found for feedback_insights_report';
    END IF;

    IF catalog_enterprise_id <> NEW.enterprise_id THEN
      RAISE EXCEPTION 'catalog_item enterprise_id mismatch in feedback_insights_report';
    END IF;

    IF catalog_kind <> NEW.scope_type THEN
      RAISE EXCEPTION 'scope_type must match catalog_item kind in feedback_insights_report';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$
;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.validate_questions_of_feedbacks_context()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  catalog_kind text;
  catalog_enterprise_id uuid;
BEGIN
  IF NEW.scope_type = 'COMPANY' THEN
    IF NEW.catalog_item_id IS NOT NULL THEN
      RAISE EXCEPTION 'catalog_item_id must be null when scope_type is COMPANY';
    END IF;
  ELSE
    IF NEW.catalog_item_id IS NULL THEN
      RAISE EXCEPTION 'catalog_item_id is required for item scope questions';
    END IF;

    SELECT ci.kind, ci.enterprise_id
    INTO catalog_kind, catalog_enterprise_id
    FROM public.catalog_items ci
    WHERE ci.id = NEW.catalog_item_id;

    IF catalog_kind IS NULL THEN
      RAISE EXCEPTION 'catalog_item not found for questions_of_feedbacks';
    END IF;

    IF catalog_enterprise_id <> NEW.enterprise_id THEN
      RAISE EXCEPTION 'catalog_item enterprise_id mismatch in questions_of_feedbacks';
    END IF;

    IF catalog_kind <> NEW.scope_type THEN
      RAISE EXCEPTION 'scope_type must match catalog_item kind';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$
;
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.catalog_items FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.collecting_data_enterprise FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.collection_points FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.customer FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.enterprise FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.feedback FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.feedback_analysis FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.feedback_insights_report FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER validate_feedback_insights_report_context BEFORE INSERT OR UPDATE ON public.feedback_insights_report FOR EACH ROW EXECUTE FUNCTION validate_feedback_insights_report_context();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.feedback_question_subquestions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.questions_of_feedbacks FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER validate_questions_of_feedbacks_context BEFORE INSERT OR UPDATE ON public.questions_of_feedbacks FOR EACH ROW EXECUTE FUNCTION validate_questions_of_feedbacks_context();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.tracked_devices FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
ALTER TABLE public.catalog_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.collecting_data_enterprise ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.collection_points ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.customer ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.enterprise ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.feedback_analysis ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.feedback_insights_report ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.feedback_question_answers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.feedback_question_subquestions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.feedback_subquestion_answers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.questions_of_feedbacks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.tracked_devices ENABLE ROW LEVEL SECURITY;
