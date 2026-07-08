-- Cache COMPARTILHADO das contas de anúncios (1 linha, id='shared'). A lista de contas é igual
-- pra todos os gestores (conexão Meta compartilhada do admin), então o PublishForm lê daqui
-- (0 chamada Meta no page load) e só o botão "Carregar novas contas" força re-buscar da Meta.
-- Escrita SÓ via service_role (edge meta-ad-accounts) — sem policy de INSERT/UPDATE p/ authenticated.
CREATE TABLE public.ad_accounts_cache (
  id text PRIMARY KEY DEFAULT 'shared',
  accounts jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ad_accounts_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read ad_accounts_cache" ON public.ad_accounts_cache
  FOR SELECT TO authenticated USING (true);
-- escrita só via service_role (edge), sem policy de write
