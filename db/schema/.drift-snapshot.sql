CREATE SCHEMA public;

CREATE FUNCTION public.can_device_send_feedback(enterprise_id_param uuid, device_fingerprint_param text, collection_point_id_param uuid DEFAULT NULL::uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
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
$$;

CREATE FUNCTION public.clean_user_metadata_before_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;

CREATE FUNCTION public.create_enterprise_on_signup() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;

CREATE FUNCTION public.document_exists(p_document text) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists(select 1 from public.enterprise e where e.document = p_document);
$$;

CREATE FUNCTION public.enterprise_public_documents_fn() RETURNS TABLE(document text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT DISTINCT document FROM public.enterprise;
$$;

CREATE FUNCTION public.enterprise_public_ids_fn() RETURNS TABLE(id uuid, document text, account_type text)
    LANGUAGE sql SECURITY DEFINER
    AS $$
  SELECT DISTINCT e.id, e.document, e.account_type FROM public.enterprise e;
$$;

CREATE FUNCTION public.generate_device_fingerprint(user_agent_param text, ip_address_param inet) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  RETURN md5(
    COALESCE(user_agent_param, '') || '|' ||
    COALESCE(ip_address_param::TEXT, '') || '|' ||
    extract(epoch from date_trunc('day', now()))::TEXT
  );
END;
$$;

CREATE FUNCTION public.jwt_custom_claims() RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
  SELECT jsonb_build_object(
    'role', 'enterprise',
    'enterprise_id', (select id from public.enterprise where auth_user_id = auth.uid())
  );
$$;

CREATE FUNCTION public.phone_exists(p_phone text) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'auth', 'public'
    AS $$
  select exists(select 1 from auth.users u where u.phone = p_phone);
$$;

CREATE FUNCTION public.register_device_feedback(enterprise_id_param uuid, device_fingerprint_param text, user_agent_param text, ip_address_param inet, customer_id_param uuid DEFAULT NULL::uuid, collection_point_id_param uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
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
$$;

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.validate_feedback_insights_report_context() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;

CREATE FUNCTION public.validate_questions_of_feedbacks_context() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;

CREATE TABLE public.account (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    access_token text,
    refresh_token text,
    access_token_expires_at timestamp with time zone,
    refresh_token_expires_at timestamp with time zone,
    scope text,
    id_token text,
    password text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.catalog_items (
    enterprise_id uuid NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    description text,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT catalog_items_kind_check CHECK ((kind = ANY (ARRAY['PRODUCT'::text, 'SERVICE'::text, 'DEPARTMENT'::text]))),
    CONSTRAINT catalog_items_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'INACTIVE'::text])))
);

CREATE TABLE public.collecting_data_enterprise (
    uses_company_products boolean DEFAULT false NOT NULL,
    uses_company_services boolean DEFAULT false NOT NULL,
    uses_company_departments boolean DEFAULT false NOT NULL,
    enterprise_id uuid NOT NULL,
    company_objective text,
    analytics_goal text,
    business_summary text,
    main_products_or_services text[],
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.collection_points (
    enterprise_id uuid NOT NULL,
    catalog_item_id uuid,
    name text NOT NULL,
    type text NOT NULL,
    identifier text,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.customer (
    name text,
    email text,
    gender text,
    enterprise_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.enterprise (
    document text NOT NULL,
    auth_user_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    account_type text,
    terms_version text,
    terms_accepted_at timestamp with time zone,
    trial_ends_at timestamp with time zone,
    subscription_status text DEFAULT 'TRIAL'::text,
    CONSTRAINT enterprise_account_type_check CHECK (((account_type IS NULL) OR (account_type = ANY (ARRAY['CPF'::text, 'CNPJ'::text])))),
    CONSTRAINT enterprise_subscription_status_check CHECK ((subscription_status = ANY (ARRAY['TRIAL'::text, 'ACTIVE'::text, 'EXPIRED'::text, 'CANCELED'::text])))
);

CREATE TABLE public."user" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text,
    email text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    image text,
    phone text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE VIEW public.enterprise_public AS
 SELECT e.id,
    COALESCE(pu.name, (au.raw_user_meta_data ->> 'full_name'::text)) AS name
   FROM ((public.enterprise e
     LEFT JOIN public."user" pu ON ((pu.id = e.auth_user_id)))
     LEFT JOIN auth.users au ON ((au.id = e.auth_user_id)));

CREATE TABLE public.feedback (
    message text NOT NULL,
    rating integer,
    collection_point_id uuid NOT NULL,
    enterprise_id uuid NOT NULL,
    tracked_device_id uuid,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.feedback_analysis (
    sentiment text,
    categories text[],
    keywords text[],
    feedback_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    aspects jsonb,
    sentiment_score numeric,
    confidence numeric
);

CREATE TABLE public.feedback_insights_report (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    enterprise_id uuid NOT NULL,
    scope_type text DEFAULT 'COMPANY'::text NOT NULL,
    catalog_item_id uuid,
    catalog_item_name text,
    summary text,
    recommendations text[],
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT feedback_insights_report_scope_type_check CHECK ((scope_type = ANY (ARRAY['COMPANY'::text, 'PRODUCT'::text, 'SERVICE'::text, 'DEPARTMENT'::text])))
);

CREATE TABLE public.feedback_question_answers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feedback_id uuid NOT NULL,
    question_id uuid NOT NULL,
    question_text_snapshot text NOT NULL,
    answer_value text NOT NULL,
    answer_score integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT feedback_question_answers_answer_score_check CHECK (((answer_score >= 1) AND (answer_score <= 5))),
    CONSTRAINT feedback_question_answers_answer_value_check CHECK ((answer_value = ANY (ARRAY['PESSIMO'::text, 'RUIM'::text, 'MEDIANA'::text, 'BOA'::text, 'OTIMA'::text])))
);

CREATE TABLE public.feedback_question_subquestions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    question_id uuid NOT NULL,
    subquestion_order integer NOT NULL,
    subquestion_text text NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT feedback_question_subquestions_order_check CHECK (((subquestion_order >= 1) AND (subquestion_order <= 3)))
);

CREATE TABLE public.feedback_subquestion_answers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feedback_id uuid NOT NULL,
    subquestion_id uuid NOT NULL,
    subquestion_text_snapshot text NOT NULL,
    answer_value text NOT NULL,
    answer_score integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT feedback_subquestion_answers_answer_score_check CHECK (((answer_score >= 1) AND (answer_score <= 5))),
    CONSTRAINT feedback_subquestion_answers_answer_value_check CHECK ((answer_value = ANY (ARRAY['PESSIMO'::text, 'RUIM'::text, 'MEDIANA'::text, 'BOA'::text, 'OTIMA'::text])))
);

CREATE TABLE public.questions_of_feedbacks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    enterprise_id uuid NOT NULL,
    scope_type text NOT NULL,
    catalog_item_id uuid,
    question_order integer NOT NULL,
    question_text text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT questions_of_feedbacks_question_order_check CHECK (((question_order >= 1) AND (question_order <= 3))),
    CONSTRAINT questions_of_feedbacks_scope_type_check CHECK ((scope_type = ANY (ARRAY['COMPANY'::text, 'PRODUCT'::text, 'SERVICE'::text, 'DEPARTMENT'::text])))
);

CREATE TABLE public.session (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    ip_address text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.tracked_devices (
    enterprise_id uuid NOT NULL,
    customer_id uuid,
    device_fingerprint text,
    blocked_reason text,
    blocked_at timestamp with time zone,
    blocked_by uuid,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    is_blocked boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    user_agent text,
    ip_address inet,
    last_feedback_at timestamp with time zone,
    feedback_count integer DEFAULT 0
);

CREATE TABLE public.verification (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.catalog_items
    ADD CONSTRAINT catalog_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.collecting_data_enterprise
    ADD CONSTRAINT collecting_data_enterprise_enterprise_unique UNIQUE (enterprise_id);

ALTER TABLE ONLY public.collecting_data_enterprise
    ADD CONSTRAINT collecting_data_enterprise_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.collection_points
    ADD CONSTRAINT collection_points_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.customer
    ADD CONSTRAINT customer_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.enterprise
    ADD CONSTRAINT enterprise_auth_user_id_key UNIQUE (auth_user_id);

ALTER TABLE ONLY public.enterprise
    ADD CONSTRAINT enterprise_document_key UNIQUE (document);

ALTER TABLE ONLY public.enterprise
    ADD CONSTRAINT enterprise_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.feedback_analysis
    ADD CONSTRAINT feedback_analysis_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.feedback_insights_report
    ADD CONSTRAINT feedback_insights_report_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.feedback
    ADD CONSTRAINT feedback_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.feedback_question_answers
    ADD CONSTRAINT feedback_question_answers_feedback_question_unique UNIQUE (feedback_id, question_id);

ALTER TABLE ONLY public.feedback_question_answers
    ADD CONSTRAINT feedback_question_answers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.feedback_question_subquestions
    ADD CONSTRAINT feedback_question_subquestions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.feedback_question_subquestions
    ADD CONSTRAINT feedback_question_subquestions_question_order_unique UNIQUE (question_id, subquestion_order);

ALTER TABLE public.feedback_question_subquestions
    ADD CONSTRAINT feedback_question_subquestions_text_length_check CHECK (((char_length(btrim(subquestion_text)) >= 20) AND (char_length(btrim(subquestion_text)) <= 150))) NOT VALID;

ALTER TABLE ONLY public.feedback_subquestion_answers
    ADD CONSTRAINT feedback_subquestion_answers_feedback_subquestion_unique UNIQUE (feedback_id, subquestion_id);

ALTER TABLE ONLY public.feedback_subquestion_answers
    ADD CONSTRAINT feedback_subquestion_answers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.questions_of_feedbacks
    ADD CONSTRAINT questions_of_feedbacks_pkey PRIMARY KEY (id);

ALTER TABLE public.questions_of_feedbacks
    ADD CONSTRAINT questions_of_feedbacks_question_text_length_check CHECK (((char_length(btrim(question_text)) >= 20) AND (char_length(btrim(question_text)) <= 150))) NOT VALID;

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_token_key UNIQUE (token);

ALTER TABLE ONLY public.tracked_devices
    ADD CONSTRAINT tracked_devices_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_email_key UNIQUE (email);

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_phone_key UNIQUE (phone);

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);

CREATE INDEX idx_catalog_items_enterprise_kind ON public.catalog_items USING btree (enterprise_id, kind);

CREATE INDEX idx_catalog_items_status ON public.catalog_items USING btree (status);

CREATE INDEX idx_collection_points_catalog_item_id ON public.collection_points USING btree (catalog_item_id);

CREATE INDEX idx_feedback_insights_report_enterprise_updated ON public.feedback_insights_report USING btree (enterprise_id, updated_at DESC);

CREATE INDEX idx_feedback_question_answers_feedback_id ON public.feedback_question_answers USING btree (feedback_id);

CREATE INDEX idx_feedback_question_answers_question_id ON public.feedback_question_answers USING btree (question_id);

CREATE INDEX idx_feedback_question_subquestions_active ON public.feedback_question_subquestions USING btree (question_id, is_active, subquestion_order);

CREATE INDEX idx_feedback_question_subquestions_question_id ON public.feedback_question_subquestions USING btree (question_id);

CREATE INDEX idx_feedback_subquestion_answers_feedback_id ON public.feedback_subquestion_answers USING btree (feedback_id);

CREATE INDEX idx_feedback_subquestion_answers_subquestion_id ON public.feedback_subquestion_answers USING btree (subquestion_id);

CREATE INDEX idx_questions_context ON public.questions_of_feedbacks USING btree (enterprise_id, scope_type, catalog_item_id, is_active);

CREATE UNIQUE INDEX uq_feedback_insights_context ON public.feedback_insights_report USING btree (enterprise_id, scope_type, catalog_item_id) NULLS NOT DISTINCT;

CREATE UNIQUE INDEX uq_questions_company_order ON public.questions_of_feedbacks USING btree (enterprise_id, question_order) WHERE ((scope_type = 'COMPANY'::text) AND (catalog_item_id IS NULL));

CREATE UNIQUE INDEX uq_questions_item_order ON public.questions_of_feedbacks USING btree (enterprise_id, scope_type, catalog_item_id, question_order) WHERE ((scope_type = ANY (ARRAY['PRODUCT'::text, 'SERVICE'::text, 'DEPARTMENT'::text])) AND (catalog_item_id IS NOT NULL));

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.catalog_items FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.collecting_data_enterprise FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.collection_points FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.customer FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.enterprise FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.feedback FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.feedback_analysis FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.feedback_insights_report FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.feedback_question_subquestions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.questions_of_feedbacks FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.tracked_devices FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER validate_feedback_insights_report_context BEFORE INSERT OR UPDATE ON public.feedback_insights_report FOR EACH ROW EXECUTE FUNCTION public.validate_feedback_insights_report_context();

CREATE TRIGGER validate_questions_of_feedbacks_context BEFORE INSERT OR UPDATE ON public.questions_of_feedbacks FOR EACH ROW EXECUTE FUNCTION public.validate_questions_of_feedbacks_context();

ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.catalog_items
    ADD CONSTRAINT catalog_items_enterprise_id_fkey FOREIGN KEY (enterprise_id) REFERENCES public.enterprise(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.collection_points
    ADD CONSTRAINT collection_points_catalog_item_id_fkey FOREIGN KEY (catalog_item_id) REFERENCES public.catalog_items(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.collection_points
    ADD CONSTRAINT collection_points_enterprise_id_fkey FOREIGN KEY (enterprise_id) REFERENCES public.enterprise(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.enterprise
    ADD CONSTRAINT enterprise_auth_user_id_user_fkey FOREIGN KEY (auth_user_id) REFERENCES public."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.feedback_analysis
    ADD CONSTRAINT feedback_analysis_feedback_id_fkey FOREIGN KEY (feedback_id) REFERENCES public.feedback(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.feedback
    ADD CONSTRAINT feedback_enterprise_id_fkey FOREIGN KEY (enterprise_id) REFERENCES public.enterprise(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.feedback_insights_report
    ADD CONSTRAINT feedback_insights_report_catalog_item_id_fkey FOREIGN KEY (catalog_item_id) REFERENCES public.catalog_items(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.feedback_insights_report
    ADD CONSTRAINT feedback_insights_report_enterprise_id_fkey FOREIGN KEY (enterprise_id) REFERENCES public.enterprise(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.feedback_question_answers
    ADD CONSTRAINT feedback_question_answers_feedback_id_fkey FOREIGN KEY (feedback_id) REFERENCES public.feedback(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.feedback_question_answers
    ADD CONSTRAINT feedback_question_answers_question_id_fkey FOREIGN KEY (question_id) REFERENCES public.questions_of_feedbacks(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.feedback_question_subquestions
    ADD CONSTRAINT feedback_question_subquestions_question_id_fkey FOREIGN KEY (question_id) REFERENCES public.questions_of_feedbacks(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.feedback_subquestion_answers
    ADD CONSTRAINT feedback_subquestion_answers_feedback_id_fkey FOREIGN KEY (feedback_id) REFERENCES public.feedback(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.feedback_subquestion_answers
    ADD CONSTRAINT feedback_subquestion_answers_subquestion_id_fkey FOREIGN KEY (subquestion_id) REFERENCES public.feedback_question_subquestions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.questions_of_feedbacks
    ADD CONSTRAINT questions_of_feedbacks_catalog_item_id_fkey FOREIGN KEY (catalog_item_id) REFERENCES public.catalog_items(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.questions_of_feedbacks
    ADD CONSTRAINT questions_of_feedbacks_enterprise_id_fkey FOREIGN KEY (enterprise_id) REFERENCES public.enterprise(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tracked_devices
    ADD CONSTRAINT tracked_devices_enterprise_id_fkey FOREIGN KEY (enterprise_id) REFERENCES public.enterprise(id) ON DELETE CASCADE;

ALTER TABLE public.catalog_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.collecting_data_enterprise ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.collection_points ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.customer ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.enterprise ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.feedback_analysis ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.feedback_insights_report ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.feedback_question_answers ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.feedback_question_subquestions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.feedback_subquestion_answers ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.questions_of_feedbacks ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.tracked_devices ENABLE ROW LEVEL SECURITY;
