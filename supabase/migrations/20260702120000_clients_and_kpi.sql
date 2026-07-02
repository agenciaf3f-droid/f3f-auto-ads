-- Aba Clientes: cadastro de clientes, contas de anúncio vinculadas e regras de KPI por conta/preset.
-- Multi-tenant por user_id (RLS auth.uid()), mesmo padrão de meta_connections/publish_jobs.

-- clients
CREATE TABLE public.clients (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own clients" ON public.clients FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own clients" ON public.clients FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own clients" ON public.clients FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own clients" ON public.clients FOR DELETE USING (auth.uid() = user_id);
CREATE TRIGGER update_clients_updated_at BEFORE UPDATE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- client_ad_accounts (N contas por cliente; 1 conta pertence a 1 cliente por gestor)
CREATE TABLE public.client_ad_accounts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  ad_account_id TEXT NOT NULL,       -- "act_..." como vem de meta-ad-accounts
  ad_account_name TEXT,              -- snapshot no momento do link
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, ad_account_id)
);
ALTER TABLE public.client_ad_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own client_ad_accounts" ON public.client_ad_accounts FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own client_ad_accounts" ON public.client_ad_accounts FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own client_ad_accounts" ON public.client_ad_accounts FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own client_ad_accounts" ON public.client_ad_accounts FOR DELETE USING (auth.uid() = user_id);
CREATE INDEX client_ad_accounts_client_idx ON public.client_ad_accounts (client_id);

-- client_kpi_rules (por CONTA DE ANÚNCIO, por preset, por métrica)
CREATE TABLE public.client_kpi_rules (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_ad_account_id UUID NOT NULL REFERENCES public.client_ad_accounts(id) ON DELETE CASCADE,
  preset_bucket TEXT NOT NULL CHECK (preset_bucket IN ('FASE 1','FASE 2','FASE 3','L.T')),
  metric_key TEXT NOT NULL,          -- validado no FE contra METRIC_REGISTRY
  comparator TEXT NOT NULL CHECK (comparator IN ('>', '<')),
  threshold_value NUMERIC NOT NULL,
  label_if_triggered TEXT NOT NULL DEFAULT 'ruim',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_ad_account_id, preset_bucket, metric_key)
);
ALTER TABLE public.client_kpi_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own client_kpi_rules" ON public.client_kpi_rules FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own client_kpi_rules" ON public.client_kpi_rules FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own client_kpi_rules" ON public.client_kpi_rules FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own client_kpi_rules" ON public.client_kpi_rules FOR DELETE USING (auth.uid() = user_id);
CREATE TRIGGER update_client_kpi_rules_updated_at BEFORE UPDATE ON public.client_kpi_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE INDEX client_kpi_rules_account_idx ON public.client_kpi_rules (client_ad_account_id);
