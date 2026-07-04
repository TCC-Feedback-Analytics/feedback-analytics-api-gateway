-- Seed determinístico do banco LOCAL (IDs fixos). Aplicado pelo scripts/db-local.mjs
-- após o schema. Duas empresas (A e B) para exercitar o isolamento multi-tenant.

BEGIN;

TRUNCATE
  auth.users, public.enterprise, public.collecting_data_enterprise,
  public.catalog_items, public.collection_points, public.questions_of_feedbacks,
  public.feedback_question_subquestions, public.feedback,
  public.feedback_question_answers, public.feedback_subquestion_answers,
  public.feedback_analysis, public.feedback_insights_report,
  public.customer, public.tracked_devices
  RESTART IDENTITY CASCADE;

-- Usuários (auth.users mínima local)
INSERT INTO auth.users (id, email, phone, raw_user_meta_data, email_confirmed_at) VALUES
  ('11111111-1111-1111-1111-111111111111', 'gestor.a@teste.local', '+5511999990001', '{"full_name":"Gestor A"}', now()),
  ('22222222-2222-2222-2222-222222222222', 'gestor.b@teste.local', '+5511999990002', '{"full_name":"Gestor B"}', now());

-- Empresas
INSERT INTO public.enterprise (id, auth_user_id, document, account_type, terms_version, terms_accepted_at, trial_ends_at, subscription_status) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '12.345.678/0001-99', 'CNPJ', 'v1', now(), now() + interval '4 months', 'TRIAL'),
  ('bbbbbbbb-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', '98.765.432/0001-11', 'CNPJ', 'v1', now(), now() + interval '4 months', 'TRIAL');

-- Dados de coleta / contexto de IA
INSERT INTO public.collecting_data_enterprise (enterprise_id, company_objective, analytics_goal, business_summary, main_products_or_services, uses_company_products) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Ser referência em atendimento', 'Reduzir feedbacks negativos', 'Restaurante italiano', ARRAY['Massa','Risoto']::text[], true),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Excelência no serviço', 'Aumentar satisfação', 'Salão de beleza', ARRAY['Corte','Coloração']::text[], true);

-- Ponto de coleta COMPANY (QR geral) por empresa
INSERT INTO public.collection_points (id, enterprise_id, catalog_item_id, name, type, status) VALUES
  ('cccccccc-0000-0000-0000-0000000000aa', 'aaaaaaaa-0000-0000-0000-000000000001', NULL, 'QR Geral A', 'QR_CODE', 'ACTIVE'),
  ('cccccccc-0000-0000-0000-0000000000bb', 'bbbbbbbb-0000-0000-0000-000000000001', NULL, 'QR Geral B', 'QR_CODE', 'ACTIVE');

-- Perguntas COMPANY (>= 20 caracteres)
INSERT INTO public.questions_of_feedbacks (id, enterprise_id, scope_type, catalog_item_id, question_order, question_text, is_active) VALUES
  ('dddddddd-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000001', 'COMPANY', NULL, 1, 'Como você avalia o atendimento recebido hoje?', true),
  ('dddddddd-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-000000000001', 'COMPANY', NULL, 2, 'Como você avalia a qualidade dos produtos oferecidos?', true);

-- Feedbacks — empresa A (notas variadas: 5,4,2,3,5 → média 3,8)
INSERT INTO public.feedback (id, enterprise_id, collection_point_id, rating, message) VALUES
  ('f0000000-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000aa', 5, 'Atendimento excelente, muito rápido!'),
  ('f0000000-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000aa', 4, 'Boa comida, ambiente agradável.'),
  ('f0000000-0000-0000-0000-0000000000a3', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000aa', 2, 'Demorou muito para ser atendido.'),
  ('f0000000-0000-0000-0000-0000000000a4', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000aa', 3, 'Experiência mediana no geral.'),
  ('f0000000-0000-0000-0000-0000000000a5', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000aa', 5, 'Perfeito, voltarei com certeza.');

-- Feedbacks — empresa B (5,1)
INSERT INTO public.feedback (id, enterprise_id, collection_point_id, rating, message) VALUES
  ('f0000000-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000bb', 5, 'Adorei o corte, profissional atencioso.'),
  ('f0000000-0000-0000-0000-0000000000b2', 'bbbbbbbb-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000bb', 1, 'Não gostei do resultado final.');

-- Respostas estruturadas (empresa A)
INSERT INTO public.feedback_question_answers (feedback_id, question_id, question_text_snapshot, answer_value, answer_score) VALUES
  ('f0000000-0000-0000-0000-0000000000a1', 'dddddddd-0000-0000-0000-0000000000a1', 'Como você avalia o atendimento recebido hoje?', 'OTIMA', 5),
  ('f0000000-0000-0000-0000-0000000000a3', 'dddddddd-0000-0000-0000-0000000000a1', 'Como você avalia o atendimento recebido hoje?', 'RUIM', 2);

-- Análises de IA (empresa A: 3 dos 5 analisados)
INSERT INTO public.feedback_analysis (feedback_id, sentiment, categories, keywords, sentiment_score, confidence) VALUES
  ('f0000000-0000-0000-0000-0000000000a1', 'positive', ARRAY['atendimento']::text[], ARRAY['rapido','excelente']::text[], 0.90, 0.95),
  ('f0000000-0000-0000-0000-0000000000a2', 'positive', ARRAY['comida','ambiente']::text[], ARRAY['boa','agradavel']::text[], 0.60, 0.80),
  ('f0000000-0000-0000-0000-0000000000a3', 'negative', ARRAY['atendimento']::text[], ARRAY['demora']::text[], -0.70, 0.90);

COMMIT;
