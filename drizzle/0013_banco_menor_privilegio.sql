-- Banco com o mínimo de privilégio (etapa 07). O app deixa de entrar como `postgres` e passa a
-- usar o papel `feedback_app`: só lê e escreve nas tabelas, não cria, altera nem apaga estrutura.
-- As migrations continuam rodando como `postgres` (secret DATABASE_URL do GitHub).
-- A senha do `feedback_app` NÃO fica aqui: o dono a define no Supabase (docs/banco-menor-privilegio.md).

-- 1) RLS ligada em todas as tabelas: as nove que faltavam.
ALTER TABLE public."user" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.session ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.account ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.verification ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.user_onboarding ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.enterprise_ia_config ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.ia_analysis_job ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.ia_rate_budget ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.scope_diagnosis ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- 2) O papel do app, sem login até o dono dar a senha.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'feedback_app') THEN
    CREATE ROLE feedback_app NOLOGIN NOINHERIT;
  END IF;
END
$$;--> statement-breakpoint

-- 3) Só leitura e escrita de dados, nas tabelas de hoje e nas que as próximas migrations criarem.
GRANT USAGE ON SCHEMA public TO feedback_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO feedback_app;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO feedback_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO feedback_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO feedback_app;--> statement-breakpoint

-- 4) A RLS sem policy barra todo papel que não é dono da tabela. O isolamento entre empresas
-- continua na aplicação (src/db/tenantScope.ts); a policy só deixa o `feedback_app` passar.
-- Os outros papéis (como o `anon` e o `authenticated` do Supabase) seguem sem acesso.
-- Tabela nova: ENABLE ROW LEVEL SECURITY + esta mesma policy na migration que a cria.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS feedback_app_all ON public.%I', t.relname);
    EXECUTE format('CREATE POLICY feedback_app_all ON public.%I FOR ALL TO feedback_app USING (true) WITH CHECK (true)', t.relname);
  END LOOP;
END
$$;
