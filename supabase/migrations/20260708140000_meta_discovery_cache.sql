-- Cache compartilhado de descoberta Meta (contas, audiências, templates, WhatsApp, pixels, identidade).
-- A conexão Meta é COMPARTILHADA (token admin) => dados iguais p/ todos => 1 linha por (kind, account_id).
-- Edges de descoberta gravam aqui (service_role); frontend LÊ daqui = 0 chamada Meta no load.
CREATE TABLE public.meta_discovery_cache (
  kind text NOT NULL,
  account_id text NOT NULL DEFAULT 'shared',
  data jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, account_id)
);

ALTER TABLE public.meta_discovery_cache ENABLE ROW LEVEL SECURITY;

-- Qualquer gestor autenticado pode LER (cache é compartilhado).
CREATE POLICY "authenticated read meta_discovery_cache" ON public.meta_discovery_cache
  FOR SELECT TO authenticated USING (true);

-- Escrita só via service_role (edges). Sem policy de INSERT/UPDATE p/ authenticated.
